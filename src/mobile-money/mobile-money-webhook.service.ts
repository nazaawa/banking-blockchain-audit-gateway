import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { TransactionEventsService } from '../events/transaction-events.service';
import { TransactionEventType } from '../events/enums/transaction-event.enum';
import { AuditService } from '../audit/audit.service';
import { AuditDirection, AuditOutcome } from '../audit/enums/audit-direction.enum';
import { mobileMoneyConfig } from '../config/configuration';
import { SoapCommunicationException, SoapFaultException } from '../soap/exceptions/soap.exceptions';
import { SoapClientService } from '../soap/soap-client.service';
import { Transaction } from '../transactions/entities/transaction.entity';
import { MetricsService } from '../observability/metrics.service';
import { stateOf, TransactionStateMachine } from '../transactions/state/transaction-state.machine';
import type { TransactionState } from '../transactions/state/transaction-state';
import { TransactionStatus } from '../transactions/enums/transaction-status.enum';
import { MobileMoneyWebhookDto, MobileMoneyWebhookStatus } from './dto/mobile-money-webhook.dto';
import { MobileMoneyWebhookEvent } from './entities/mobile-money-webhook-event.entity';
import {
  BankProcessingStatus,
  CaseStatus,
  ReconciliationStatus,
  RefundStatus,
  WebhookProcessingStatus,
} from './enums/mobile-money.enum';
import { MobileMoneyService } from './mobile-money.service';
import { BankInstructionWorker } from './bank-instruction.worker';
import { ReconciliationService } from './reconciliation.service';

const PG_UNIQUE_VIOLATION = '23505';

/**
 * Delai au-dela duquel une reclamation en cours est reputee abandonnee
 * (processus interrompu). Genereux a dessein : il doit couvrir le pire cas
 * d'un appel SOAP avec ses reprises.
 */
const STALE_CLAIM_MS = 5 * 60_000;

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
    private readonly eventLedger: TransactionEventsService,
    private readonly stateMachine: TransactionStateMachine,
    private readonly worker: BankInstructionWorker,
    private readonly metrics: MetricsService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Inject(mobileMoneyConfig.KEY)
    private readonly config: ConfigType<typeof mobileMoneyConfig>,
  ) {}

  async handle(payload: MobileMoneyWebhookDto, signature: string): Promise<Transaction> {
    this.verifySignature(payload, signature);
    const { event, claimed } = await this.registerAndClaim(payload);

    // Deja traite, ou pris en charge par une autre instance : la reponse reste
    // idempotente et aucune seconde instruction bancaire n'est emise.
    if (!claimed) {
      return this.mobileMoney.findByAggregatorReference(payload.aggregatorReference);
    }

    // Tout ce qui suit la reclamation doit etre couvert : la resolution de la
    // transaction incluse. Laissee hors du try, une reference introuvable
    // (callback plus rapide que le commit) figeait l'evenement en PROCESSING,
    // et le rejeu de l'agregateur repartait alors en « deja traite » — la
    // confirmation de paiement etait perdue sans le moindre signal.
    try {
      const current = await this.mobileMoney.findByAggregatorReference(payload.aggregatorReference);

      const result =
        payload.status === MobileMoneyWebhookStatus.FAILED
          ? await this.mobileMoney.markProviderFailed(current, payload)
          : await this.handleConfirmation(current, payload);

      event.processingStatus = WebhookProcessingStatus.PROCESSED;
      event.processedAt = new Date();
      event.failureReason = null;
      await this.events.save(event);

      // Le registre append-only porte desormais la preuve : plus rien a sceller
      // ici, chaque fait a ete consigne et scelle a l'endroit ou il s'est produit.
      return result;
    } catch (error) {
      // Relacher la reclamation est indispensable : un evenement laisse en
      // PROCESSING ne serait plus jamais retraite. FAILED est re-reclamable.
      event.processingStatus = WebhookProcessingStatus.FAILED;
      event.failureReason = this.errorMessage(error).slice(0, 1024);
      await this.events.save(event);

      this.logger.warn({
        event: 'mobile-money.webhook.failed',
        eventId: payload.eventId,
        aggregatorReference: payload.aggregatorReference,
        reason: this.errorMessage(error),
        detail: 'Evenement remis a disposition pour un rejeu',
      });
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

  /**
   * Serialisation canonique du payload signe.
   *
   * Chaque champ est prefixe de sa longueur. Une simple concatenation par
   * separateur serait ambigue : aucun champ n'interdisant le caractere « | »,
   * deplacer la frontiere entre deux champs adjacents produisait la meme
   * chaine — donc la meme signature. Un callback legitime pouvait ainsi etre
   * rejoue en reaffectant la confirmation a une autre reference agregateur.
   *
   * Le prefixe de longueur rend le decoupage injectif : une seule suite de
   * champs peut produire une chaine donnee.
   */
  private canonicalPayload(payload: MobileMoneyWebhookDto): string {
    return [
      payload.eventId,
      payload.aggregatorReference,
      payload.status,
      Number(payload.amount).toFixed(2),
      payload.currency,
      payload.occurredAt,
      payload.failureReason ?? '',
    ]
      .map((field) => {
        const value = String(field ?? '');
        return `${Buffer.byteLength(value, 'utf8')}:${value}`;
      })
      .join('|');
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

    if (event.processingStatus === WebhookProcessingStatus.PROCESSED) {
      return { event, claimed: false };
    }

    // Un arret brutal entre la reclamation et son denouement laisserait
    // l'evenement en PROCESSING indefiniment. Passe le delai de garde, il
    // redevient reclamable ; le predicat `bank_status = NOT_STARTED` cote
    // transaction interdit de toute maniere une seconde instruction bancaire.
    if (
      event.processingStatus === WebhookProcessingStatus.PROCESSING &&
      !this.isClaimExpired(event)
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
    const claim = await this.mobileMoney.confirmAndClaimBankProcessing(
      transaction,
      payload,
      async (confirmed, manager) => {
        await this.worker.enqueue(confirmed, manager);
      },
    );
    if (!claim.claimed) {
      return claim.transaction.reconciliationStatus === ReconciliationStatus.MATCHED
        ? this.reconciliation.reconcile(claim.transaction)
        : claim.transaction;
    }
    // Le webhook accuse reception, il ne rend pas compte d'une execution.
    // L'instruction a deja ete mise en file dans la meme transaction SQL que
    // la confirmation : l'agregateur n'attend donc jamais le back-office.
    return claim.transaction;
  }

  /**
   * Execute l'instruction bancaire, declenchee par le travailleur.
   *
   * Publique parce qu'elle est le point d'entree de la file, non parce qu'un
   * client HTTP l'atteint.
   */
  async executeBankInstruction(transaction: Transaction): Promise<Transaction> {
    const before = stateOf(transaction);

    let bankResult: Awaited<ReturnType<SoapClientService['convertAmountToWords']>>;
    try {
      bankResult = await this.soapClient.convertAmountToWords(Number(transaction.amount));
    } catch (error) {
      // Distinction decisive, et deja faite ailleurs sur les remboursements :
      //
      //  - une **faute metier** est un refus du back-office. La marteler
      //    produirait le meme refus : l'echec est applique tout de suite, la
      //    dette envers le payeur s'ouvre, et le travailleur n'a rien a rejouer.
      //  - un **incident de transport** ne dit rien de l'issue. Le relever le
      //    rend au travailleur, qui reessaiera apres un recul.
      //
      // Les confondre — ce que faisait la version couplee — condamnait un
      // virement pour un simple hoquet reseau.
      if (error instanceof SoapFaultException) {
        return this.handleBankFailure(transaction, before, error);
      }
      throw error;
    }

    return this.applyBankSuccess(transaction, before, bankResult);
  }

  /**
   * Applique une reponse bancaire positive : audit, etat, fait consigne,
   * rapprochement.
   *
   * Separee de l'appel lui-meme depuis que la file existe : le travailleur
   * decide quoi rejouer, ce service dit quoi faire du resultat.
   */
  private async applyBankSuccess(
    transaction: Transaction,
    before: TransactionState,
    bankResult: Awaited<ReturnType<SoapClientService['convertAmountToWords']>>,
  ): Promise<Transaction> {
    const { amountInWords, exchange } = bankResult;

    // Mesure prise chez l'appelant, non dans le client : c'est la duree que la
    // passerelle a reellement subie, et c'est le seul endroit observable quand
    // le client est bouchonne.
    this.metrics.soapDuration.observe(
      { operation: exchange.operation, outcome: 'success' },
      exchange.durationMs / 1000,
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
    const completed = await this.dataSource.transaction(async (manager) => {
      const persisted = await manager.getRepository(Transaction).save(transaction);
      this.stateMachine.assertTransition(before, stateOf(persisted), persisted.reference);

      await this.eventLedger.record(
        {
          type: TransactionEventType.BANK_PROCESSING_COMPLETED,
          transaction: persisted,
          detail: `Instruction bancaire executee en ${exchange.durationMs} ms`,
        },
        manager,
      );

      return persisted;
    });

    // Le rapprochement reste **hors** de la transaction ci-dessus, et porte la
    // sienne. La banque a reellement execute : un incident au rapprochement ne
    // doit pas effacer ce fait. Le dossier restera simplement a rapprocher, ce
    // que `runPending` reprend.
    return this.reconciliation.reconcile(completed);
  }

  /**
   * Traduit uniquement un echec de l'appel bancaire.
   *
   * Cette methode ne doit pas envelopper la persistance du succes, le registre
   * d'evenements ou le rapprochement : un incident local apres une reponse SOAP
   * positive ne signifie pas que la banque a echoue.
   */
  private async handleBankFailure(
    transaction: Transaction,
    before: TransactionState,
    error: unknown,
  ): Promise<Transaction> {
    transaction.status = TransactionStatus.FAILED;
    transaction.bankStatus = BankProcessingStatus.FAILED;
    transaction.reconciliationStatus = ReconciliationStatus.MANUAL_REVIEW;
    transaction.reconciliationReason =
      'Confirmation Mobile Money recue mais echec du traitement bancaire SOAP';
    transaction.failureReason = this.errorMessage(error);
    transaction.processedAt = new Date();

    // Cas le plus lourd du flux : le fournisseur a encaisse et le beneficiaire
    // n'a rien recu. La dette envers le payeur doit etre portee explicitement,
    // sinon elle n'existe que dans un message d'erreur que personne ne relit.
    transaction.refundStatus = RefundStatus.REQUIRED;
    transaction.caseStatus = CaseStatus.MANUAL_REVIEW;
    transaction.caseReason =
      'Encaissement fournisseur confirme, instruction bancaire en echec : ' +
      'remboursement du payeur a instruire';

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
    //
    // L'echec et la dette qu'il ouvre sont ecrits d'un bloc : l'encaissement a
    // eu lieu sans contrepartie, et un etat qui porterait l'echec sans le
    // dossier de remboursement laisserait cette dette sans trace opposable.
    return this.dataSource.transaction(async (manager) => {
      const failed = await manager.getRepository(Transaction).save(transaction);
      this.stateMachine.assertTransition(before, stateOf(failed), failed.reference);

      await this.eventLedger.record(
        {
          type: TransactionEventType.BANK_PROCESSING_FAILED,
          transaction: failed,
          detail: failed.failureReason,
        },
        manager,
      );
      await this.eventLedger.record(
        {
          type: TransactionEventType.CASE_OPENED,
          transaction: failed,
          detail: failed.caseReason,
        },
        manager,
      );

      return failed;
    });
  }

  /**
   * Une reclamation plus ancienne que le delai de garde est consideree comme
   * abandonnee. En cas de doute (horodatage absent) on ne reclame pas : mieux
   * vaut un evenement bloque, traitable par l'exploitation, qu'un paiement
   * traite deux fois.
   */
  private isClaimExpired(event: MobileMoneyWebhookEvent): boolean {
    const claimedAt = event.updatedAt?.getTime();
    if (claimedAt === undefined || Number.isNaN(claimedAt)) return false;
    return Date.now() - claimedAt > STALE_CLAIM_MS;
  }

  private isUniqueViolation(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) return false;
    return (error.driverError as { code?: string } | undefined)?.code === PG_UNIQUE_VIOLATION;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Erreur inconnue';
  }
}
