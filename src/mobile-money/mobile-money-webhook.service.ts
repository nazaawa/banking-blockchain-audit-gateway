import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { QueryFailedError, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { AuditDirection, AuditOutcome } from '../audit/enums/audit-direction.enum';
import { mobileMoneyConfig } from '../config/configuration';
import { SoapCommunicationException, SoapFaultException } from '../soap/exceptions/soap.exceptions';
import { SoapClientService } from '../soap/soap-client.service';
import { Transaction } from '../transactions/entities/transaction.entity';
import { TransactionStatus } from '../transactions/enums/transaction-status.enum';
import { MobileMoneyWebhookDto, MobileMoneyWebhookStatus } from './dto/mobile-money-webhook.dto';
import { MobileMoneyWebhookEvent } from './entities/mobile-money-webhook-event.entity';
import {
  BankProcessingStatus,
  ReconciliationStatus,
  WebhookProcessingStatus,
} from './enums/mobile-money.enum';
import { MobileMoneyService } from './mobile-money.service';
import { ReconciliationService } from './reconciliation.service';

const PG_UNIQUE_VIOLATION = '23505';

/** Authentification, deduplication et orchestration des callbacks agregateur. */
@Injectable()
export class MobileMoneyWebhookService {
  private readonly logger = new Logger(MobileMoneyWebhookService.name);

  constructor(
    @InjectRepository(MobileMoneyWebhookEvent)
    private readonly events: Repository<MobileMoneyWebhookEvent>,
    @InjectRepository(Transaction)
    private readonly transactions: Repository<Transaction>,
    private readonly mobileMoney: MobileMoneyService,
    private readonly soapClient: SoapClientService,
    private readonly auditService: AuditService,
    private readonly reconciliation: ReconciliationService,
    @Inject(mobileMoneyConfig.KEY)
    private readonly config: ConfigType<typeof mobileMoneyConfig>,
  ) {}

  async handle(payload: MobileMoneyWebhookDto, signature: string): Promise<Transaction> {
    this.verifySignature(payload, signature);
    const { event, claimed } = await this.registerAndClaim(payload);
    const current = await this.mobileMoney.findByAggregatorReference(payload.aggregatorReference);

    if (!claimed) return current;

    try {
      const result =
        payload.status === MobileMoneyWebhookStatus.FAILED
          ? await this.mobileMoney.markProviderFailed(current, payload)
          : await this.handleConfirmation(current, payload);

      event.processingStatus = WebhookProcessingStatus.PROCESSED;
      event.processedAt = new Date();
      event.failureReason = null;
      await this.events.save(event);
      return result;
    } catch (error) {
      event.processingStatus = WebhookProcessingStatus.FAILED;
      event.failureReason = this.errorMessage(error).slice(0, 1024);
      await this.events.save(event);
      throw error;
    }
  }

  /** Signature partagee avec le simulateur pour reproduire un vrai callback. */
  sign(payload: MobileMoneyWebhookDto): string {
    const digest = createHmac('sha256', this.config.webhookSecret)
      .update(this.canonicalPayload(payload))
      .digest('hex');
    return `sha256=${digest}`;
  }

  private verifySignature(payload: MobileMoneyWebhookDto, signature: string): void {
    const expected = Buffer.from(this.sign(payload));
    const received = Buffer.from(signature ?? '');
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      throw new UnauthorizedException({
        error: 'INVALID_WEBHOOK_SIGNATURE',
        message: 'La signature du webhook Mobile Money est invalide',
      });
    }
  }

  private canonicalPayload(payload: MobileMoneyWebhookDto): string {
    return [
      payload.eventId,
      payload.aggregatorReference,
      payload.status,
      Number(payload.amount).toFixed(2),
      payload.currency,
      payload.occurredAt,
      payload.failureReason ?? '',
    ].join('|');
  }

  private async registerAndClaim(
    payload: MobileMoneyWebhookDto,
  ): Promise<{ event: MobileMoneyWebhookEvent; claimed: boolean }> {
    let event: MobileMoneyWebhookEvent;
    try {
      event = await this.events.save(
        this.events.create({
          eventId: payload.eventId,
          aggregatorReference: payload.aggregatorReference,
          payload: { ...payload },
          processingStatus: WebhookProcessingStatus.RECEIVED,
          failureReason: null,
        }),
      );
    } catch (error) {
      if (!this.isUniqueViolation(error)) throw error;
      event = await this.events.findOneByOrFail({ eventId: payload.eventId });
      if (
        event.aggregatorReference !== payload.aggregatorReference ||
        this.canonicalPayload(event.payload as unknown as MobileMoneyWebhookDto) !==
          this.canonicalPayload(payload)
      ) {
        throw new ConflictException({
          error: 'WEBHOOK_EVENT_CONFLICT',
          message: 'Cet eventId a deja ete utilise avec un contenu different',
        });
      }
    }

    if (
      event.processingStatus === WebhookProcessingStatus.PROCESSED ||
      event.processingStatus === WebhookProcessingStatus.PROCESSING
    ) {
      return { event, claimed: false };
    }

    const claimed = await this.events.update(
      {
        id: event.id,
        processingStatus: event.processingStatus,
      },
      {
        processingStatus: WebhookProcessingStatus.PROCESSING,
        failureReason: null,
      },
    );
    if (claimed.affected !== 1) {
      return {
        event: await this.events.findOneByOrFail({ id: event.id }),
        claimed: false,
      };
    }
    event.processingStatus = WebhookProcessingStatus.PROCESSING;
    return { event, claimed: true };
  }

  private async handleConfirmation(
    transaction: Transaction,
    payload: MobileMoneyWebhookDto,
  ): Promise<Transaction> {
    const claim = await this.mobileMoney.confirmAndClaimBankProcessing(transaction, payload);
    if (!claim.claimed) return claim.transaction;
    return this.callBankAndReconcile(claim.transaction);
  }

  private async callBankAndReconcile(transaction: Transaction): Promise<Transaction> {
    try {
      const { amountInWords, exchange } = await this.soapClient.convertAmountToWords(
        Number(transaction.amount),
      );

      await this.auditService.record({
        direction: AuditDirection.OUTBOUND_REQUEST,
        outcome: AuditOutcome.SUCCESS,
        operation: exchange.operation,
        endpoint: exchange.endpoint,
        transactionReference: transaction.reference,
        correlationId: transaction.correlationId,
        rawPayload: exchange.rawRequest,
      });
      await this.auditService.record({
        direction: AuditDirection.INBOUND_RESPONSE,
        outcome: AuditOutcome.SUCCESS,
        operation: exchange.operation,
        endpoint: exchange.endpoint,
        transactionReference: transaction.reference,
        correlationId: transaction.correlationId,
        rawPayload: exchange.rawResponse,
        durationMs: exchange.durationMs,
        httpStatus: 200,
      });

      transaction.status = TransactionStatus.COMPLETED;
      transaction.bankStatus = BankProcessingStatus.COMPLETED;
      transaction.amountInWords = amountInWords;
      transaction.soapOperation = exchange.operation;
      transaction.soapDurationMs = exchange.durationMs;
      transaction.soapAttempts = exchange.attempts;
      transaction.processedAt = new Date();
      const completed = await this.transactions.save(transaction);
      return this.reconciliation.reconcile(completed);
    } catch (error) {
      transaction.status = TransactionStatus.FAILED;
      transaction.bankStatus = BankProcessingStatus.FAILED;
      transaction.reconciliationStatus = ReconciliationStatus.MANUAL_REVIEW;
      transaction.reconciliationReason =
        'Confirmation Mobile Money recue mais echec du traitement bancaire SOAP';
      transaction.failureReason = this.errorMessage(error);
      transaction.processedAt = new Date();

      if (error instanceof SoapFaultException) {
        transaction.soapOperation = error.operation;
        transaction.faultCode = error.fault.faultCode;
        transaction.faultString = error.fault.faultString;
      }
      if (error instanceof SoapCommunicationException) {
        transaction.soapOperation = error.operation;
        transaction.soapAttempts = error.attempts;
      }

      await this.auditService.record({
        direction:
          error instanceof SoapFaultException
            ? AuditDirection.INBOUND_FAULT
            : AuditDirection.COMMUNICATION_ERROR,
        outcome: error instanceof SoapFaultException ? AuditOutcome.FAULT : AuditOutcome.ERROR,
        operation: transaction.soapOperation ?? 'MobileMoneyBankProcessing',
        transactionReference: transaction.reference,
        correlationId: transaction.correlationId,
        faultCode: transaction.faultCode,
        faultString: transaction.faultString,
        message: transaction.failureReason,
      });

      this.logger.warn({
        event: 'mobile-money.bank-processing.failed',
        reference: transaction.reference,
        reason: transaction.failureReason,
      });
      // Le callback est acquitte : l'echec bancaire est un etat metier durable,
      // pas une raison de demander a l'agregateur de rejouer le paiement.
      return this.transactions.save(transaction);
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) return false;
    return (error.driverError as { code?: string } | undefined)?.code === PG_UNIQUE_VIOLATION;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Erreur inconnue';
  }
}
