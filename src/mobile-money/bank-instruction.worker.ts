import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, LessThanOrEqual, Repository } from 'typeorm';
import { mobileMoneyConfig } from '../config/configuration';
import { TransactionEventType } from '../events/enums/transaction-event.enum';
import { TransactionEventsService } from '../events/transaction-events.service';
import { Transaction } from '../transactions/entities/transaction.entity';
import { TransactionStatus } from '../transactions/enums/transaction-status.enum';
import { stateOf, TransactionStateMachine } from '../transactions/state/transaction-state.machine';
import { BankInstruction, BankInstructionStatus } from './entities/bank-instruction.entity';
import {
  BankProcessingStatus,
  CaseStatus,
  ReconciliationStatus,
  RefundStatus,
} from './enums/mobile-money.enum';

const WORKER_JOB = 'bank-instruction-worker';

/** Recul exponentiel, plafonne : 2s, 4s, 8s, 16s, puis 30s. */
const backoffMs = (attempts: number): number => Math.min(2 ** attempts * 1000, 30_000);

/** Bail d'une reclamation : passe ce delai, un autre processus peut la reprendre. */
const IN_FLIGHT_LEASE_MS = 5 * 60_000;

export interface DrainOutcome {
  claimed: number;
  completed: number;
  deadLettered: number;
}

/**
 * Travailleur drainant les instructions bancaires en attente.
 *
 * ## Ce que le decouplage apporte
 *
 * Avant lui, une seule erreur SOAP condamnait definitivement le virement : la
 * jambe bancaire passait en echec, une dette naissait, un dossier s'ouvrait. Un
 * simple hoquet reseau produisait donc un remboursement a instruire.
 *
 * Les tentatives sont desormais espacees par un recul exponentiel. Un incident
 * passager se resorbe sans qu'aucun humain n'intervienne, et seul un echec
 * durable ouvre un dossier.
 *
 * ## La file d'echecs definitifs
 *
 * Apres N tentatives, l'instruction part en `DEAD_LETTER`. Ce n'est pas un
 * abandon silencieux : le fait est consigne au registre, la dette envers le
 * payeur est ouverte, et le dossier passe en revue humaine. **Un echec
 * definitif doit produire une obligation, pas une ligne de journal.**
 *
 * ## Concurrence
 *
 * La reclamation utilise `SKIP LOCKED` : plusieurs instances peuvent drainer la
 * file de front sans jamais se disputer la meme instruction, et sans qu'un
 * verrou global ne les serialise inutilement.
 */
@Injectable()
export class BankInstructionWorker implements OnModuleInit {
  private readonly logger = new Logger(BankInstructionWorker.name);
  private running = false;

  constructor(
    @InjectRepository(BankInstruction)
    private readonly instructions: Repository<BankInstruction>,
    private readonly events: TransactionEventsService,
    private readonly stateMachine: TransactionStateMachine,
    private readonly scheduler: SchedulerRegistry,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Inject(mobileMoneyConfig.KEY)
    private readonly config: ConfigType<typeof mobileMoneyConfig>,
  ) {}

  onModuleInit(): void {
    if (!this.config.bankWorkerEnabled) {
      this.logger.warn({
        event: 'bank-instruction.worker.disabled',
        detail: 'Les instructions resteront en file : drainez-les explicitement.',
      });
      return;
    }

    const interval = setInterval(() => {
      void this.drain().catch((error: unknown) => {
        this.logger.error({
          event: 'bank-instruction.worker.failed',
          reason: error instanceof Error ? error.message : 'erreur inconnue',
        });
      });
    }, this.config.bankWorkerIntervalMs);

    this.scheduler.addInterval(WORKER_JOB, interval);
    this.logger.log({
      event: 'bank-instruction.worker.started',
      intervalMs: this.config.bankWorkerIntervalMs,
    });
  }

  /**
   * Met une instruction en file, dans la transaction de l'appelant.
   *
   * L'unicite sur la reference rend l'operation idempotente : une notification
   * rejouee ne peut pas produire un second appel bancaire.
   */
  async enqueue(transaction: Transaction, manager: EntityManager): Promise<BankInstruction> {
    const repository = manager.getRepository(BankInstruction);

    return repository.save(
      repository.create({
        transactionReference: transaction.reference,
        status: BankInstructionStatus.PENDING,
        correlationId: transaction.correlationId,
        nextAttemptAt: new Date(),
      }),
    );
  }

  /**
   * Traite les instructions echues.
   *
   * @param execute appel effectif au back-office, injecte par le module pour
   *        eviter un cycle : le travailleur pilote la file, il ne connait pas
   *        le detail de l'integration bancaire.
   */
  async drain(
    execute?: (transaction: Transaction) => Promise<void>,
    limit = 20,
  ): Promise<DrainOutcome> {
    if (this.running) return { claimed: 0, completed: 0, deadLettered: 0 };

    // Le resserrement se fait ici plutot que par une assertion : sans executant
    // branche, il n'y a rien a drainer, et le dire tot evite d'avoir a jurer
    // plus bas que la valeur est definie.
    const run = execute ?? this.executor;
    if (!run) return { claimed: 0, completed: 0, deadLettered: 0 };

    this.running = true;
    const outcome: DrainOutcome = { claimed: 0, completed: 0, deadLettered: 0 };

    try {
      for (let processed = 0; processed < limit; processed += 1) {
        const claimed = await this.claimNext();
        if (!claimed) break;

        outcome.claimed += 1;
        const settled = await this.attempt(claimed.instruction, claimed.transaction, run);
        if (settled === 'COMPLETED') outcome.completed += 1;
        if (settled === 'DEAD_LETTER') outcome.deadLettered += 1;
      }
    } finally {
      this.running = false;
    }

    return outcome;
  }

  private executor?: (transaction: Transaction) => Promise<void>;

  /** Branche l'execution bancaire, une fois le module construit. */
  useExecutor(execute: (transaction: Transaction) => Promise<void>): void {
    this.executor = execute;
  }

  /**
   * Reclame la prochaine instruction echue.
   *
   * `SKIP LOCKED` plutot qu'un verrou global : plusieurs instances drainent la
   * file de front, chacune sur des lignes distinctes.
   */
  private async claimNext(): Promise<{
    instruction: BankInstruction;
    transaction: Transaction;
  } | null> {
    return this.dataSource.transaction(async (manager) => {
      const instruction = await manager
        .getRepository(BankInstruction)
        .createQueryBuilder('instruction')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .where(
          `(
            instruction.status = :pending
            AND instruction.nextAttemptAt <= :now
          ) OR (
            instruction.status = :inFlight
            AND instruction.updatedAt <= :leaseExpiredAt
          )`,
          {
            pending: BankInstructionStatus.PENDING,
            inFlight: BankInstructionStatus.IN_FLIGHT,
            now: new Date(),
            leaseExpiredAt: new Date(Date.now() - IN_FLIGHT_LEASE_MS),
          },
        )
        .orderBy('instruction.nextAttemptAt', 'ASC')
        .getOne();

      if (!instruction) return null;

      const transaction = await manager
        .getRepository(Transaction)
        .findOneBy({ reference: instruction.transactionReference });

      if (!transaction) {
        // La transaction a disparu : garder l'instruction en file la ferait
        // tourner indefiniment sans jamais aboutir.
        instruction.status = BankInstructionStatus.DEAD_LETTER;
        instruction.lastError = 'Transaction introuvable';
        instruction.retryable = false;
        await manager.getRepository(BankInstruction).save(instruction);
        return null;
      }

      instruction.status = BankInstructionStatus.IN_FLIGHT;
      instruction.attempts += 1;
      await manager.getRepository(BankInstruction).save(instruction);

      return { instruction, transaction };
    });
  }

  private async attempt(
    instruction: BankInstruction,
    transaction: Transaction,
    execute: (transaction: Transaction) => Promise<void>,
  ): Promise<'COMPLETED' | 'RETRY' | 'DEAD_LETTER'> {
    try {
      // Un arret peut survenir apres la persistance du resultat bancaire mais
      // avant celle de l'instruction. A la reprise, l'etat metier durable evite
      // de rejouer un appel deja applique localement.
      if (
        transaction.bankStatus === BankProcessingStatus.COMPLETED ||
        transaction.bankStatus === BankProcessingStatus.FAILED ||
        transaction.bankStatus === BankProcessingStatus.BLOCKED
      ) {
        instruction.status = BankInstructionStatus.COMPLETED;
        instruction.lastError = null;
        await this.instructions.save(instruction);
        return 'COMPLETED';
      }

      // L'appel externe reste **hors** transaction SQL : aucun verrou n'est tenu
      // pendant que le back-office reflechit.
      await execute(transaction);

      instruction.status = BankInstructionStatus.COMPLETED;
      instruction.lastError = null;
      await this.instructions.save(instruction);

      this.logger.log({
        event: 'bank-instruction.completed',
        reference: instruction.transactionReference,
        attempts: instruction.attempts,
      });

      return 'COMPLETED';
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'erreur inconnue';
      const exhausted = instruction.attempts >= this.config.bankWorkerMaxAttempts;

      if (!exhausted) {
        instruction.status = BankInstructionStatus.PENDING;
        instruction.lastError = reason.slice(0, 1024);
        instruction.nextAttemptAt = new Date(Date.now() + backoffMs(instruction.attempts));
        await this.instructions.save(instruction);

        this.logger.warn({
          event: 'bank-instruction.retry',
          reference: instruction.transactionReference,
          attempts: instruction.attempts,
          nextAttemptAt: instruction.nextAttemptAt,
          reason,
        });

        return 'RETRY';
      }

      await this.deadLetter(instruction, transaction, reason);
      return 'DEAD_LETTER';
    }
  }

  /**
   * Abandonne l'instruction et ouvre la dette qu'elle laisse derriere elle.
   *
   * Le fournisseur a encaisse, le beneficiaire n'a rien recu : l'echec produit
   * une **obligation**, pas seulement une trace. La consigner au registre la
   * rend opposable ; l'ouvrir en revue humaine la rend traitable.
   */
  private async deadLetter(
    instruction: BankInstruction,
    transaction: Transaction,
    reason: string,
  ): Promise<void> {
    const before = stateOf(transaction);

    await this.dataSource.transaction(async (manager) => {
      instruction.status = BankInstructionStatus.DEAD_LETTER;
      instruction.lastError = reason.slice(0, 1024);
      instruction.retryable = false;
      await manager.getRepository(BankInstruction).save(instruction);

      const updated = await manager.getRepository(Transaction).save(
        Object.assign(transaction, {
          status: TransactionStatus.FAILED,
          bankStatus: BankProcessingStatus.FAILED,
          reconciliationStatus: ReconciliationStatus.MANUAL_REVIEW,
          reconciliationReason:
            'Confirmation Mobile Money recue mais traitement bancaire abandonne apres reprises',
          refundStatus: RefundStatus.REQUIRED,
          caseStatus: CaseStatus.MANUAL_REVIEW,
          failureReason: reason.slice(0, 1024),
          processedAt: new Date(),
          caseReason:
            `Instruction bancaire abandonnee apres ${instruction.attempts} tentatives : ` +
            'encaissement confirme sans contrepartie, remboursement du payeur a instruire',
        }),
      );
      this.stateMachine.assertTransition(before, stateOf(updated), updated.reference);

      await this.events.record(
        {
          type: TransactionEventType.BANK_PROCESSING_FAILED,
          transaction: updated,
          detail: updated.failureReason,
        },
        manager,
      );
      await this.events.record(
        {
          type: TransactionEventType.CASE_OPENED,
          transaction: updated,
          detail: updated.caseReason,
        },
        manager,
      );
    });

    this.logger.error({
      event: 'bank-instruction.dead-letter',
      reference: instruction.transactionReference,
      attempts: instruction.attempts,
      reason,
      detail: 'Dette envers le payeur ouverte, dossier en revue humaine.',
    });
  }

  /** Instructions abandonnees, pour la supervision. */
  async findDeadLettered(): Promise<BankInstruction[]> {
    return this.instructions.find({
      where: { status: BankInstructionStatus.DEAD_LETTER },
      order: { updatedAt: 'DESC' },
    });
  }

  /** Nombre d'instructions echues en attente, pour les metriques. */
  async countDue(): Promise<number> {
    return this.instructions.countBy({
      status: BankInstructionStatus.PENDING,
      nextAttemptAt: LessThanOrEqual(new Date()),
    });
  }
}
