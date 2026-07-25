import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { QueryFailedError, Repository } from 'typeorm';
import { getCorrelationId } from '../common/context/request-context';
import { TransactionEventType } from '../events/enums/transaction-event.enum';
import { TransactionEventsService } from '../events/transaction-events.service';
import { amountsMatch, currenciesMatch } from '../mobile-money/amount.util';
import { CaseStatus, RefundStatus } from '../mobile-money/enums/mobile-money.enum';
import { Transaction } from '../transactions/entities/transaction.entity';
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
    @Inject(PROVIDER_REFUND_PORT)
    private readonly provider: ProviderRefundPort,
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
      this.logger.log({
        event: 'refund.already-completed',
        reference: transactionReference,
        providerRefundReference: refund.providerRefundReference,
      });
      return refund;
    }

    return this.attempt(refund, transaction);
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

      const result = await this.attempt(refund, transaction);
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
      requestedBy: requestedBy ?? null,
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
  private async attempt(refund: Refund, transaction: Transaction): Promise<Refund> {
    if (
      !ATTEMPTABLE.has(refund.status) ||
      (refund.status === RefundStatus.FAILED && !refund.retryable)
    ) {
      return refund;
    }

    const firstAttempt = refund.attempts === 0;
    refund.status = RefundStatus.REQUESTED;
    refund.attempts += 1;
    refund.requestedAt ??= new Date();
    const inFlight = await this.refunds.save(refund);

    if (firstAttempt) {
      await this.syncTransaction(transaction, RefundStatus.REQUESTED);
      await this.events.record({
        type: TransactionEventType.REFUND_REQUESTED,
        transaction,
        observedAmount: inFlight.amount,
        observedCurrency: inFlight.currency,
        detail: `Remboursement de ${inFlight.amount.toFixed(2)} ${inFlight.currency} demande`,
      });
    }

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
      );
    } catch (error) {
      return this.recordFailure(inFlight, transaction, error);
    }
  }

  private async recordSuccess(
    refund: Refund,
    transaction: Transaction,
    providerRefundReference: string,
    deduplicated: boolean,
  ): Promise<Refund> {
    refund.status = RefundStatus.COMPLETED;
    refund.providerRefundReference = providerRefundReference;
    refund.completedAt = new Date();
    refund.lastError = null;
    refund.retryable = false;
    const completed = await this.refunds.save(refund);

    // La dette est eteinte : le dossier d'exception n'a plus lieu d'etre ouvert.
    const updated = await this.syncTransaction(
      transaction,
      RefundStatus.COMPLETED,
      CaseStatus.RESOLVED,
    );

    await this.events.record({
      type: TransactionEventType.REFUND_COMPLETED,
      transaction: updated,
      observedAmount: completed.amount,
      observedCurrency: completed.currency,
      detail:
        `Remboursement confirme (${providerRefundReference})` +
        (deduplicated ? ' — reprise d une demande anterieure' : ''),
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
    const failed = await this.refunds.save(refund);

    // Le dossier reste ouvert : la dette envers le payeur n'est pas eteinte.
    const updated = await this.syncTransaction(transaction, RefundStatus.FAILED);

    await this.events.record({
      type: TransactionEventType.REFUND_FAILED,
      transaction: updated,
      observedAmount: failed.amount,
      observedCurrency: failed.currency,
      detail: `Tentative ${failed.attempts} en echec : ${reason}`,
    });

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
  ): Promise<Transaction> {
    await this.transactions.update(
      { id: transaction.id },
      { refundStatus, ...(caseStatus ? { caseStatus } : {}) },
    );

    const updated = await this.transactions.findOneByOrFail({ id: transaction.id });
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
