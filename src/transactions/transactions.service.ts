import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  GatewayTimeoutException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { businessConfig } from '../config/configuration';
import { getCorrelationId } from '../common/context/request-context';
import { AuditService } from '../audit/audit.service';
import { AuditDirection, AuditOutcome } from '../audit/enums/audit-direction.enum';
import type { AuditLog } from '../audit/entities/audit-log.entity';
import { SoapClientService } from '../soap/soap-client.service';
import {
  SoapCommunicationException,
  SoapFaultException,
  SoapParsingException,
} from '../soap/exceptions/soap.exceptions';
import { CreateTransferDto } from './dto/create-transfer.dto';
import { PaginatedTransfersDto, QueryTransfersDto } from './dto/query-transfers.dto';
import { TransferResponseDto } from './dto/transfer-response.dto';
import { Transaction } from './entities/transaction.entity';
import { TransactionStatus } from './enums/transaction-status.enum';
import { ReferenceGenerator } from './reference.generator';
import { TransactionsRepository } from './transactions.repository';

/** Nombre de generations de reference tentees avant abandon en cas de collision. */
const MAX_REFERENCE_ATTEMPTS = 5;

/**
 * Orchestration d'une demande de virement.
 *
 * Enchainement : validation metier -> idempotence -> persistance (PENDING) ->
 * appel SOAP (PROCESSING) -> analyse de la reponse -> statut terminal
 * (COMPLETED / FAILED) -> audit.
 *
 * La transaction est **toujours** persistee avant l'appel externe : meme si
 * l'echange echoue, le client peut consulter la demande via sa reference.
 */
@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(
    private readonly repository: TransactionsRepository,
    private readonly soapClient: SoapClientService,
    private readonly auditService: AuditService,
    private readonly referenceGenerator: ReferenceGenerator,
    @Inject(businessConfig.KEY)
    private readonly config: ConfigType<typeof businessConfig>,
  ) {}

  /**
   * Initie un virement.
   *
   * @param idempotencyKey en-tete `Idempotency-Key` : un rejeu renvoie la
   *        transaction d'origine sans nouvel appel au service externe.
   */
  async initiateTransfer(dto: CreateTransferDto, idempotencyKey?: string): Promise<Transaction> {
    this.assertBusinessRules(dto);

    if (idempotencyKey) {
      const existing = await this.repository.findByIdempotencyKey(idempotencyKey);
      if (existing) {
        this.logger.log({
          event: 'transfer.idempotent.replay',
          correlationId: getCorrelationId(),
          reference: existing.reference,
        });
        return existing;
      }
    }

    const { transaction, isNew } = await this.persistPendingTransaction(dto, idempotencyKey);

    // Une course d'idempotence a ete perdue : la transaction gagnante est deja
    // prise en charge par l'autre requete. La rejouer emettrait un second appel
    // SOAP pour un seul virement.
    if (!isNew) return transaction;

    return this.processTransaction(transaction);
  }

  /** Retourne une transaction par sa reference fonctionnelle. */
  async findByReference(reference: string): Promise<Transaction> {
    const transaction = await this.repository.findByReference(reference);
    if (!transaction) {
      throw new NotFoundException({
        error: 'TRANSACTION_NOT_FOUND',
        message: `Aucune transaction pour la reference ${reference}`,
      });
    }
    return transaction;
  }

  /** Liste paginee des transactions. */
  async list(query: QueryTransfersDto): Promise<PaginatedTransfersDto> {
    const [items, total] = await this.repository.paginate(query);

    return {
      items: items.map((item) => TransferResponseDto.fromEntity(item)),
      total,
      page: query.page,
      limit: query.limit,
      pages: query.limit > 0 ? Math.ceil(total / query.limit) : 0,
    };
  }

  /** Piste d'audit des echanges SOAP lies a une transaction. */
  async getAuditTrail(reference: string): Promise<AuditLog[]> {
    await this.findByReference(reference);
    return this.auditService.findByTransactionReference(reference);
  }

  // -------------------------------------------------------------------------
  // Regles metier
  // -------------------------------------------------------------------------

  /**
   * Controles non exprimables par les decorateurs de DTO : ils dependent de la
   * configuration ou croisent plusieurs champs.
   */
  private assertBusinessRules(dto: CreateTransferDto): void {
    if (!this.config.allowedCurrencies.includes(dto.currency)) {
      throw new BadRequestException({
        error: 'CURRENCY_NOT_ALLOWED',
        message:
          `Devise ${dto.currency} non autorisee. ` +
          `Devises acceptees : ${this.config.allowedCurrencies.join(', ')}`,
      });
    }

    if (dto.amount > this.config.maxAmount) {
      throw new UnprocessableEntityException({
        error: 'AMOUNT_LIMIT_EXCEEDED',
        message: `Le montant depasse le plafond autorise de ${this.config.maxAmount}`,
      });
    }

    if (dto.debtorIban === dto.creditorIban) {
      throw new UnprocessableEntityException({
        error: 'SAME_ACCOUNT_TRANSFER',
        message: 'Le compte donneur d ordre et le compte beneficiaire doivent etre distincts',
      });
    }
  }

  // -------------------------------------------------------------------------
  // Persistance
  // -------------------------------------------------------------------------

  /**
   * Enregistre la demande au statut PENDING.
   *
   * La reference est retiree si la contrainte d'unicite la rejette (collision
   * du tirage aleatoire) ; une collision sur la cle d'idempotence signale un
   * rejeu concurrent et renvoie la transaction gagnante avec `isNew: false`.
   */
  private async persistPendingTransaction(
    dto: CreateTransferDto,
    idempotencyKey?: string,
  ): Promise<{ transaction: Transaction; isNew: boolean }> {
    const correlationId = getCorrelationId();

    for (let attempt = 1; attempt <= MAX_REFERENCE_ATTEMPTS; attempt += 1) {
      const transaction = this.repository.create({
        reference: this.referenceGenerator.generate(),
        idempotencyKey: idempotencyKey ?? null,
        status: TransactionStatus.PENDING,
        debtorIban: dto.debtorIban,
        debtorName: dto.debtorName ?? null,
        creditorIban: dto.creditorIban,
        creditorName: dto.creditorName,
        amount: dto.amount,
        currency: dto.currency,
        endToEndLabel: dto.endToEndLabel ?? null,
        correlationId,
      });

      try {
        const saved = await this.repository.save(transaction);

        this.logger.log({
          event: 'transfer.registered',
          correlationId,
          reference: saved.reference,
          currency: saved.currency,
          // Le montant n'est pas un secret ; l'IBAN, si.
          amount: saved.amount,
        });

        return { transaction: saved, isNew: true };
      } catch (error) {
        // Rejeu concurrent avec la meme cle d'idempotence : l'autre requete a gagne.
        if (idempotencyKey && this.repository.isUniqueViolation(error, 'idempotency')) {
          const winner = await this.repository.findByIdempotencyKey(idempotencyKey);
          if (winner) return { transaction: winner, isNew: false };

          throw new ConflictException({
            error: 'IDEMPOTENCY_CONFLICT',
            message: 'Une requete concurrente utilise deja cette cle d idempotence',
          });
        }

        if (this.repository.isUniqueViolation(error) && attempt < MAX_REFERENCE_ATTEMPTS) {
          this.logger.warn({
            event: 'transfer.reference.collision',
            correlationId,
            attempt,
          });
          continue;
        }

        throw error;
      }
    }

    throw new InternalServerErrorException({
      error: 'REFERENCE_GENERATION_FAILED',
      message: `Impossible de generer une reference unique apres ${MAX_REFERENCE_ATTEMPTS} tentatives`,
    });
  }

  // -------------------------------------------------------------------------
  // Integration SOAP
  // -------------------------------------------------------------------------

  /** Appelle le service externe puis fait converger la transaction vers un statut terminal. */
  private async processTransaction(transaction: Transaction): Promise<Transaction> {
    transaction.status = TransactionStatus.PROCESSING;
    await this.repository.save(transaction);

    try {
      const { amountInWords, exchange } = await this.soapClient.convertAmountToWords(
        transaction.amount,
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
      transaction.amountInWords = amountInWords;
      transaction.soapOperation = exchange.operation;
      transaction.soapDurationMs = exchange.durationMs;
      transaction.soapAttempts = exchange.attempts;
      transaction.processedAt = new Date();

      const completed = await this.repository.save(transaction);

      this.logger.log({
        event: 'transfer.completed',
        correlationId: transaction.correlationId,
        reference: completed.reference,
        durationMs: exchange.durationMs,
      });

      return completed;
    } catch (error) {
      return this.handleProcessingFailure(transaction, error);
    }
  }

  /**
   * Marque la transaction en echec, consigne l'audit, puis traduit l'erreur
   * d'integration en reponse HTTP porteuse de la reference : le client peut
   * toujours interroger `GET /transfers/{reference}`.
   */
  private async handleProcessingFailure(transaction: Transaction, error: unknown): Promise<never> {
    transaction.status = TransactionStatus.FAILED;
    transaction.processedAt = new Date();

    if (error instanceof SoapFaultException) {
      transaction.soapOperation = error.operation;
      transaction.faultCode = error.fault.faultCode;
      transaction.faultString = error.fault.faultString;
      transaction.failureReason = error.message;

      await this.repository.save(transaction);
      await this.auditService.record({
        direction: AuditDirection.INBOUND_FAULT,
        outcome: AuditOutcome.FAULT,
        operation: error.operation,
        transactionReference: transaction.reference,
        correlationId: transaction.correlationId,
        rawPayload: error.rawResponse ?? null,
        faultCode: error.fault.faultCode,
        faultString: error.fault.faultString,
        message: error.message,
      });

      this.logger.warn({
        event: 'transfer.failed',
        correlationId: transaction.correlationId,
        reference: transaction.reference,
        cause: 'SOAP_FAULT',
        faultCode: error.fault.faultCode,
      });

      throw new BadGatewayException({
        error: 'SOAP_FAULT',
        message: `Le service externe a retourne une faute : ${error.fault.faultString}`,
        reference: transaction.reference,
        details: {
          faultCode: error.fault.faultCode,
          faultString: error.fault.faultString,
          soapVersion: error.fault.soapVersion,
          operation: error.operation,
        },
      });
    }

    if (error instanceof SoapCommunicationException) {
      transaction.soapOperation = error.operation;
      transaction.soapAttempts = error.attempts;
      transaction.failureReason = error.message;

      await this.repository.save(transaction);
      await this.auditService.record({
        direction: AuditDirection.COMMUNICATION_ERROR,
        outcome: AuditOutcome.ERROR,
        operation: error.operation,
        transactionReference: transaction.reference,
        correlationId: transaction.correlationId,
        message: error.message,
      });

      this.logger.warn({
        event: 'transfer.failed',
        correlationId: transaction.correlationId,
        reference: transaction.reference,
        cause: error.timedOut ? 'SOAP_TIMEOUT' : 'SOAP_UNAVAILABLE',
        attempts: error.attempts,
      });

      const payload = {
        error: error.timedOut ? 'SOAP_TIMEOUT' : 'SOAP_UNAVAILABLE',
        message: error.timedOut
          ? 'Le service externe n a pas repondu dans le delai imparti'
          : 'Le service externe est injoignable',
        reference: transaction.reference,
        details: { operation: error.operation, attempts: error.attempts },
      };

      throw error.timedOut
        ? new GatewayTimeoutException(payload)
        : new BadGatewayException(payload);
    }

    if (error instanceof SoapParsingException) {
      transaction.soapOperation = error.operation;
      transaction.failureReason = error.message;

      await this.repository.save(transaction);
      await this.auditService.record({
        direction: AuditDirection.COMMUNICATION_ERROR,
        outcome: AuditOutcome.ERROR,
        operation: error.operation,
        transactionReference: transaction.reference,
        correlationId: transaction.correlationId,
        message: error.message,
      });

      this.logger.error({
        event: 'transfer.failed',
        correlationId: transaction.correlationId,
        reference: transaction.reference,
        cause: 'SOAP_INVALID_RESPONSE',
        reason: error.message,
      });

      throw new BadGatewayException({
        error: 'SOAP_INVALID_RESPONSE',
        message: 'La reponse du service externe est inexploitable',
        reference: transaction.reference,
        details: { operation: error.operation },
      });
    }

    // Erreur non prevue : on marque l'echec sans divulguer le detail technique.
    transaction.failureReason = 'Erreur interne pendant le traitement';
    await this.repository.save(transaction);

    this.logger.error({
      event: 'transfer.failed',
      correlationId: transaction.correlationId,
      reference: transaction.reference,
      cause: 'UNEXPECTED',
      reason: error instanceof Error ? error.message : 'erreur inconnue',
      stack: error instanceof Error ? error.stack : undefined,
    });

    throw new InternalServerErrorException({
      error: 'TRANSFER_PROCESSING_FAILED',
      message: 'Le traitement du virement a echoue',
      reference: transaction.reference,
    });
  }
}
