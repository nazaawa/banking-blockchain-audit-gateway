import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError, Repository } from 'typeorm';
import { getCorrelationId } from '../common/context/request-context';
import { TransactionEventType } from '../events/enums/transaction-event.enum';
import { EventActionOrigin, EventActorRole } from '../events/enums/event-actor.enum';
import { TransactionEventsService } from '../events/transaction-events.service';
import { amountsMatch, currenciesMatch } from '../mobile-money/amount.util';
import { CaseStatus, RefundStatus } from '../mobile-money/enums/mobile-money.enum';
import { Transaction } from '../transactions/entities/transaction.entity';
import { MetricsService } from '../observability/metrics.service';
import { stateOf, TransactionStateMachine } from '../transactions/state/transaction-state.machine';
import { Refund } from './entities/refund.entity';
import {
  PROVIDER_REFUND_PORT,
  ProviderRefundRejectedException,
  ProviderRefundUnavailableException,
  type ProviderRefundPort,
} from './provider-refund.port';

const PG_UNIQUE_VIOLATION = '23505';

/** Etats depuis lesquels une tentative aupres du fournisseur est legitime. */
const ATTEMPTABLE: ReadonlySet<RefundStatus> = new Set([
  RefundStatus.REQUIRED,
  RefundStatus.REQUESTED,
  RefundStatus.FAILED,
]);

interface AttemptActor {
  actorId: string;
  actorRole: EventActorRole;
  actionOrigin: EventActionOrigin;
  /** Seuls les appels humains modifient la separation des taches. */
  manual: boolean;
}

/**
 * Remboursement du payeur.
 *
 * ## Quand une dette nait
 *
 * Des que le fournisseur a encaisse sans que le virement aboutisse : ecart de
 * montant refuse avant instruction, ou echec de la jambe bancaire apres
 * encaissement. Dans les deux cas le payeur a ete debite sans contrepartie.
 *
 * ## Ce qui est rembourse
 *
 * Le montant **effectivement encaisse** par le fournisseur, jamais le montant
 * commande. Sur un ecart les deux different, et restituer la commande
 * enrichirait le payeur de la difference.
 *
 * ## Pourquoi la reprise est sure
 *
 * Un echange interrompu laisse l'issue inconnue : impossible de savoir si le
 * fournisseur a enregistre la demande. La cle d'idempotence, generee une fois et
 * transmise a chaque tentative, transfere la deduplication au fournisseur — le
 * seul a pouvoir trancher. Rejouer devient alors sans danger.
 */
@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    @InjectRepository(Refund)
    private readonly refunds: Repository<Refund>,
    @InjectRepository(Transaction)
    private readonly transactions: Repository<Transaction>,
    private readonly events: TransactionEventsService,
    private readonly stateMachine: TransactionStateMachine,
    private readonly metrics: MetricsService,
    @Inject(PROVIDER_REFUND_PORT)
    private readonly provider: ProviderRefundPort,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Demande le remboursement d'une transaction.
   *
   * Idempotent : un second appel sur un dossier deja abouti renvoie l'existant
   * sans solliciter le fournisseur.
   */
  async requestRefund(transactionReference: string, requestedBy?: string): Promise<Refund> {
    const transaction = await this.loadRefundable(transactionReference);
    const refund = await this.findOrCreate(transaction, requestedBy);

    if (refund.status === RefundStatus.COMPLETED) {
      // Un incident apres la confirmation fournisseur peut avoir persiste le
      // succes avant la cloture du registre. Le rejeu repare cette derniere
      // idempotemment sans solliciter de nouveau le fournisseur.
      await this.events.closeCase(transaction, 'Dossier clos apres remboursement du payeur');
      this.logger.log({
        event: 'refund.already-completed',
        reference: transactionReference,
        providerRefundReference: refund.providerRefundReference,
      });
      return refund;
    }

    return this.attempt(
      refund,
      transaction,
      requestedBy
        ? {
            actorId: requestedBy,
            actorRole: EventActorRole.REFUND_OPERATOR,
            actionOrigin: EventActionOrigin.API,
            manual: true,
          }
        : undefined,
    );
  }

  /**
   * Rouvre un dossier ferme par un refus metier.
   *
   * Un refus n'est definitif que tant que sa cause subsiste chez le fournisseur.
   * Une fois celle-ci levee — solde recharge, plafond releve — le dossier doit
   * pouvoir repartir sans qu'un operateur ait a toucher la base : une ecriture
   * directe echapperait au registre, et la reouverture ne serait pas prouvable.
   */
  async reopenRefund(transactionReference: string, reopenedBy?: string): Promise<Refund> {
    return this.dataSource.transaction(async (manager) => {
      const refunds = manager.getRepository(Refund);
      const transactions = manager.getRepository(Transaction);
      const refund = await refunds.findOne({
        where: { transactionReference },
        // Serialise deux decisions de reouverture concurrentes : la seconde
        // relit `retryable=true` apres le commit de la premiere et est refusee.
        lock: { mode: 'pessimistic_write' },
      });
      if (!refund) {
        throw new NotFoundException({
          error: 'REFUND_NOT_FOUND',
          message: `Aucun remboursement ouvert pour la reference ${transactionReference}`,
        });
      }

      if (refund.status === RefundStatus.COMPLETED) {
        throw new UnprocessableEntityException({
          error: 'REFUND_ALREADY_COMPLETED',
          message: 'Ce remboursement a abouti : il n y a rien a rouvrir',
        });
      }
      if (refund.retryable) {
        throw new UnprocessableEntityException({
          error: 'REFUND_ALREADY_RETRYABLE',
          message: 'Ce dossier est deja rejouable : une simple nouvelle demande suffit',
        });
      }

      // Separation des taches : lever un refus est une decision de controle, pas
      // la suite de l'operation qui l'a provoque. Laisser un meme acteur faire
      // les deux reviendrait a lui permettre de forcer indefiniment un
      // remboursement que le fournisseur refuse — sans qu'aucun tiers ne
      // l'examine. Le registre garde trace des deux acteurs.
      if (reopenedBy && refund.lastRequestedBy && refund.lastRequestedBy === reopenedBy) {
        throw new ForbiddenException({
          error: 'SEGREGATION_OF_DUTIES',
          message:
            'La cle qui a demande ce remboursement ne peut pas lever son refus. ' +
            'Un second acteur habilite refunds:approve doit intervenir.',
        });
      }

      const transaction = await transactions.findOneByOrFail({
        reference: transactionReference,
      });

      refund.retryable = true;
      refund.lastError = null;
      refund.lastApprovedBy = reopenedBy ?? null;

      await this.events.record(
        {
          type: TransactionEventType.REFUND_REOPENED,
          transaction,
          observedAmount: refund.amount,
          observedCurrency: refund.currency,
          detail: 'Dossier rouvert apres levee du refus fournisseur',
          actorId: reopenedBy ?? null,
          actorRole: reopenedBy ? EventActorRole.REFUND_APPROVER : null,
          actionOrigin: reopenedBy ? EventActionOrigin.API : null,
        },
        manager,
      );
      const reopened = await refunds.save(refund);

      this.logger.log({
        event: 'refund.reopened',
        reference: transactionReference,
        attempts: reopened.attempts,
        reopenedBy,
      });

      return reopened;
    });
  }

  async findByTransaction(transactionReference: string): Promise<Refund> {
    const refund = await this.refunds.findOne({ where: { transactionReference } });
    if (!refund) {
      throw new NotFoundException({
        error: 'REFUND_NOT_FOUND',
        message: `Aucun remboursement ouvert pour la reference ${transactionReference}`,
      });
    }
    return refund;
  }

  /**
   * Rejoue les dossiers dont l'issue reste indeterminee.
   *
   * Couvre les deux cas ou l'argent est bloque sans que personne n'agisse :
   * une tentative interrompue (`REQUESTED`) et un fournisseur temporairement
   * indisponible (`FAILED`).
   */
  async retryPending(limit = 20): Promise<{ examined: number; completed: number }> {
    const pending = await this.refunds.find({
      where: [{ status: RefundStatus.REQUESTED }, { status: RefundStatus.FAILED, retryable: true }],
      order: { updatedAt: 'ASC' },
      take: limit,
    });

    let completed = 0;
    for (const refund of pending) {
      const transaction = await this.transactions.findOne({
        where: { reference: refund.transactionReference },
      });
      if (!transaction) continue;

      const result = await this.attempt(refund, transaction, {
        actorId: 'refund-retry-worker',
        actorRole: EventActorRole.SYSTEM,
        actionOrigin: EventActionOrigin.RETRY_WORKER,
        manual: false,
      });
      if (result.status === RefundStatus.COMPLETED) completed += 1;
    }

    return { examined: pending.length, completed };
  }

  // -------------------------------------------------------------------------

  private async loadRefundable(transactionReference: string): Promise<Transaction> {
    const transaction = await this.transactions.findOne({
      where: { reference: transactionReference },
    });

    if (!transaction) {
      throw new NotFoundException({
        error: 'TRANSACTION_NOT_FOUND',
        message: `Aucune transaction pour la reference ${transactionReference}`,
      });
    }

    if (transaction.refundStatus === RefundStatus.NOT_REQUIRED) {
      throw new UnprocessableEntityException({
        error: 'REFUND_NOT_REQUIRED',
        message:
          'Aucune dette envers le payeur : le fournisseur n a rien encaisse, ' +
          'ou le virement a abouti',
      });
    }

    if (transaction.aggregatorAmount === null || transaction.aggregatorCurrency === null) {
      throw new UnprocessableEntityException({
        error: 'REFUND_AMOUNT_UNKNOWN',
        message: 'Montant encaisse inconnu : le remboursement ne peut pas etre chiffre',
      });
    }

    return transaction;
  }

  private async findOrCreate(transaction: Transaction, requestedBy?: string): Promise<Refund> {
    const existing = await this.refunds.findOne({
      where: { transactionReference: transaction.reference },
    });
    if (existing) return existing;

    const draft = this.refunds.create({
      transactionReference: transaction.reference,
      status: RefundStatus.REQUIRED,
      amount: Number(transaction.aggregatorAmount),
      currency: transaction.aggregatorCurrency as string,
      reason: transaction.caseReason ?? transaction.failureReason,
      providerIdempotencyKey: `RFD-${randomBytes(16).toString('hex')}`,
      attempts: 0,
      retryable: true,
      createdBy: requestedBy ?? null,
      lastRequestedBy: null,
      lastApprovedBy: null,
      correlationId: transaction.correlationId || getCorrelationId(),
    });

    try {
      return await this.refunds.save(draft);
    } catch (error) {
      // Course entre deux demandes concurrentes : la perdante reprend le dossier
      // cree par l'autre plutot que d'en ouvrir un second.
      if (this.isUniqueViolation(error)) {
        const winner = await this.refunds.findOne({
          where: { transactionReference: transaction.reference },
        });
        if (winner) return winner;
        throw new ConflictException({
          error: 'REFUND_CONFLICT',
          message: 'Une demande concurrente porte deja sur ce remboursement',
        });
      }
      throw error;
    }
  }

  /** Une tentative aupres du fournisseur, avec consignation du fait obtenu. */
  private async attempt(
    refund: Refund,
    transaction: Transaction,
    actor?: AttemptActor,
  ): Promise<Refund> {
    if (
      !ATTEMPTABLE.has(refund.status) ||
      (refund.status === RefundStatus.FAILED && !refund.retryable)
    ) {
      return refund;
    }

    refund.status = RefundStatus.REQUESTED;
    refund.attempts += 1;
    refund.requestedAt ??= new Date();
    if (actor?.manual) refund.lastRequestedBy = actor.actorId;

    // La transaction SQL se referme avant la sollicitation du fournisseur : un
    // appel reseau ne doit jamais maintenir des lignes verrouillees.
    const inFlight = await this.dataSource.transaction(async (manager) => {
      const persisted = await manager.getRepository(Refund).save(refund);

      await this.syncTransaction(transaction, RefundStatus.REQUESTED, undefined, manager);
      await this.events.record(
        {
          type: TransactionEventType.REFUND_REQUESTED,
          transaction,
          observedAmount: persisted.amount,
          observedCurrency: persisted.currency,
          detail:
            `Tentative ${persisted.attempts} de remboursement de ` +
            `${persisted.amount.toFixed(2)} ${persisted.currency}`,
          actorId: actor?.actorId ?? null,
          actorRole: actor?.actorRole ?? null,
          actionOrigin: actor?.actionOrigin ?? null,
        },
        manager,
      );

      return persisted;
    });

    try {
      const result = await this.provider.refund({
        idempotencyKey: inFlight.providerIdempotencyKey,
        providerReference: transaction.aggregatorReference as string,
        amount: inFlight.amount,
        currency: inFlight.currency,
      });

      return await this.recordSuccess(
        inFlight,
        transaction,
        result.providerRefundReference,
        result.deduplicated,
        actor,
      );
    } catch (error) {
      return this.recordFailure(inFlight, transaction, error, actor);
    }
  }

  private async recordSuccess(
    refund: Refund,
    transaction: Transaction,
    providerRefundReference: string,
    deduplicated: boolean,
    actor?: AttemptActor,
  ): Promise<Refund> {
    refund.status = RefundStatus.COMPLETED;
    refund.providerRefundReference = providerRefundReference;
    refund.completedAt = new Date();
    refund.lastError = null;
    refund.retryable = false;
    // Extinction de la dette, resolution du dossier et cloture forment un tout.
    // C'est cette cloture qui rend le dossier ancrable : la publier alors qu'un
    // des trois manquerait reviendrait a sceller un etat qui n'a pas existe.
    const completed = await this.dataSource.transaction(async (manager) => {
      const persisted = await manager.getRepository(Refund).save(refund);

      // La dette est eteinte : le dossier d'exception n'a plus lieu d'etre ouvert.
      const updated = await this.syncTransaction(
        transaction,
        RefundStatus.COMPLETED,
        CaseStatus.RESOLVED,
        manager,
      );

      await this.events.record(
        {
          type: TransactionEventType.REFUND_COMPLETED,
          transaction: updated,
          observedAmount: persisted.amount,
          observedCurrency: persisted.currency,
          detail:
            `Remboursement confirme (${providerRefundReference})` +
            (deduplicated ? ' — reprise d une demande anterieure' : ''),
          actorId: actor?.actorId ?? null,
          actorRole: actor?.actorRole ?? null,
          actionOrigin: actor?.actionOrigin ?? null,
        },
        manager,
      );

      // La dette est eteinte et le dossier resolu : plus aucun fait n'est attendu.
      await this.events.closeCase(updated, 'Dossier clos apres remboursement du payeur', manager);

      return persisted;
    });

    this.logger.log({
      event: 'refund.completed',
      reference: refund.transactionReference,
      amount: completed.amount,
      currency: completed.currency,
      providerRefundReference,
      attempts: completed.attempts,
      deduplicated,
    });

    return completed;
  }

  private async recordFailure(
    refund: Refund,
    transaction: Transaction,
    error: unknown,
    actor?: AttemptActor,
  ): Promise<Refund> {
    const rejected = error instanceof ProviderRefundRejectedException;
    const reason =
      error instanceof ProviderRefundRejectedException ||
      error instanceof ProviderRefundUnavailableException
        ? error.reason
        : error instanceof Error
          ? error.message
          : 'erreur inconnue';

    refund.status = RefundStatus.FAILED;
    refund.lastError = reason.slice(0, 1024);
    refund.retryable = !rejected;
    const failed = await this.dataSource.transaction(async (manager) => {
      const persisted = await manager.getRepository(Refund).save(refund);

      // Le dossier reste ouvert : la dette envers le payeur n'est pas eteinte.
      const updated = await this.syncTransaction(
        transaction,
        RefundStatus.FAILED,
        undefined,
        manager,
      );

      await this.events.record(
        {
          type: TransactionEventType.REFUND_FAILED,
          transaction: updated,
          observedAmount: persisted.amount,
          observedCurrency: persisted.currency,
          detail: `Tentative ${persisted.attempts} en echec : ${reason}`,
          actorId: actor?.actorId ?? null,
          actorRole: actor?.actorRole ?? null,
          actionOrigin: actor?.actionOrigin ?? null,
        },
        manager,
      );

      return persisted;
    });

    // Un refus metier ne se resorbe pas tout seul : c'est le signal qui doit
    // reveiller un exploitant, pas la ligne de journal qu'il faudrait relire.
    this.metrics.refundsFailed.inc({ retryable: String(!rejected) });

    this.logger.error({
      event: 'refund.failed',
      reference: refund.transactionReference,
      attempts: failed.attempts,
      // Un refus metier ne sera pas resolu par un rejeu ; une indisponibilite si.
      retryable: !rejected,
      reason,
    });

    return failed;
  }

  /** Reporte l'etat du remboursement sur la transaction, source de la vue metier. */
  private async syncTransaction(
    transaction: Transaction,
    refundStatus: RefundStatus,
    caseStatus?: CaseStatus,
    manager?: EntityManager,
  ): Promise<Transaction> {
    const repository = manager?.getRepository(Transaction) ?? this.transactions;
    const before = stateOf(transaction);

    await repository.update(
      { id: transaction.id },
      { refundStatus, ...(caseStatus ? { caseStatus } : {}) },
    );

    const updated = await repository.findOneByOrFail({ id: transaction.id });

    // Point de passage unique du remboursement vers la vue metier : c'est ici
    // que se joue la regle « un dossier ne se resout pas dette pendante ».
    this.stateMachine.assertTransition(before, stateOf(updated), updated.reference);
    Object.assign(transaction, {
      refundStatus: updated.refundStatus,
      caseStatus: updated.caseStatus,
    });
    return updated;
  }

  /** Controle de coherence : le rembourse doit egaler l'encaisse. */
  isReconciled(refund: Refund, transaction: Transaction): boolean {
    return (
      refund.status === RefundStatus.COMPLETED &&
      amountsMatch(refund.amount, transaction.aggregatorAmount) &&
      currenciesMatch(refund.currency, transaction.aggregatorCurrency)
    );
  }

  private isUniqueViolation(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) return false;
    return (error.driverError as { code?: string } | undefined)?.code === PG_UNIQUE_VIOLATION;
  }
}
