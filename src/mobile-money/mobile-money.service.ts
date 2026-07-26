import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager, Repository } from 'typeorm';
import { getCorrelationId } from '../common/context/request-context';
import { businessConfig, mobileMoneyConfig } from '../config/configuration';
import { Transaction } from '../transactions/entities/transaction.entity';
import { TransactionStatus } from '../transactions/enums/transaction-status.enum';
import { ReferenceGenerator } from '../transactions/reference.generator';
import { TransactionsRepository } from '../transactions/transactions.repository';
import { stateOf, TransactionStateMachine } from '../transactions/state/transaction-state.machine';
import { TransactionEventsService } from '../events/transaction-events.service';
import { TransactionEventType } from '../events/enums/transaction-event.enum';
import { AggregatorSimulatorService } from './aggregator-simulator.service';
import { amountsMatch, currenciesMatch } from './amount.util';
import type { CreateMobileMoneyTransactionDto } from './dto/create-mobile-money-transaction.dto';
import type { MobileMoneyWebhookDto } from './dto/mobile-money-webhook.dto';
import {
  BankProcessingStatus,
  CaseStatus,
  PaymentChannel,
  ProviderStatus,
  ReconciliationStatus,
  RefundStatus,
} from './enums/mobile-money.enum';

const MAX_REFERENCE_ATTEMPTS = 5;

/** Les montants sont au centime : la commission ne fait pas exception. */
const roundToCent = (value: number): number => Math.round(value * 100) / 100;

/** Enregistrement et transitions atomiques du paiement Mobile Money. */
@Injectable()
export class MobileMoneyService {
  private readonly logger = new Logger(MobileMoneyService.name);

  constructor(
    private readonly repository: TransactionsRepository,
    @InjectRepository(Transaction)
    private readonly transactions: Repository<Transaction>,
    private readonly references: ReferenceGenerator,
    private readonly aggregator: AggregatorSimulatorService,
    private readonly events: TransactionEventsService,
    private readonly stateMachine: TransactionStateMachine,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Inject(businessConfig.KEY)
    private readonly business: ConfigType<typeof businessConfig>,
    @Inject(mobileMoneyConfig.KEY)
    private readonly config: ConfigType<typeof mobileMoneyConfig>,
  ) {}

  async initiate(
    dto: CreateMobileMoneyTransactionDto,
    idempotencyKey?: string,
  ): Promise<Transaction> {
    this.assertBusinessRules(dto);

    if (idempotencyKey) {
      const existing = await this.repository.findByIdempotencyKey(idempotencyKey);
      if (existing) {
        if (existing.paymentChannel !== PaymentChannel.MOBILE_MONEY) {
          throw new ConflictException({
            error: 'IDEMPOTENCY_KEY_REUSED',
            message: 'Cette cle d idempotence appartient deja a un autre type de paiement',
          });
        }
        return existing;
      }
    }

    for (let attempt = 1; attempt <= MAX_REFERENCE_ATTEMPTS; attempt += 1) {
      const transaction = this.repository.create({
        reference: this.references.generate(),
        idempotencyKey: idempotencyKey ?? null,
        status: TransactionStatus.PENDING,
        paymentChannel: PaymentChannel.MOBILE_MONEY,
        debtorIban: this.config.settlementIban,
        debtorName: this.config.settlementName,
        creditorIban: dto.creditorIban,
        creditorName: dto.creditorName,
        amount: dto.amount,
        currency: dto.currency,
        endToEndLabel: dto.externalReference ?? null,
        correlationId: getCorrelationId() || randomUUID(),
        mobileMoneyOperator: dto.operator,
        payerMsisdn: dto.payerMsisdn,
        aggregatorReference: this.aggregator.generateReference(),
        providerStatus: ProviderStatus.PENDING,
        bankStatus: BankProcessingStatus.NOT_STARTED,
        reconciliationStatus: ReconciliationStatus.PENDING,
      });

      try {
        // Le fait d'ouverture porte les parties du paiement : c'est la reference
        // contre laquelle la verification confronte la ligne. L'enregistrer
        // separement laisserait une fenetre ou la ligne existe sans son temoin.
        const saved = await this.dataSource.transaction(async (manager) => {
          const persisted = await this.repository.save(transaction, manager);
          this.stateMachine.assertInitialState(stateOf(persisted), persisted.reference);

          await this.events.record(
            {
              type: TransactionEventType.PAYMENT_INITIATED,
              transaction: persisted,
              detail: `Paiement ${persisted.mobileMoneyOperator} initie`,
            },
            manager,
          );

          return persisted;
        });

        this.logger.log({
          event: 'mobile-money.initiated',
          reference: saved.reference,
          aggregatorReference: saved.aggregatorReference,
          operator: saved.mobileMoneyOperator,
        });
        return saved;
      } catch (error) {
        if (idempotencyKey && this.repository.isUniqueViolation(error, 'idempotency')) {
          const winner = await this.repository.findByIdempotencyKey(idempotencyKey);
          if (winner?.paymentChannel === PaymentChannel.MOBILE_MONEY) return winner;
          if (winner) {
            throw new ConflictException({
              error: 'IDEMPOTENCY_KEY_REUSED',
              message: 'Cette cle d idempotence appartient deja a un autre type de paiement',
            });
          }
        }
        if (this.repository.isUniqueViolation(error) && attempt < MAX_REFERENCE_ATTEMPTS) continue;
        throw error;
      }
    }

    throw new InternalServerErrorException({
      error: 'REFERENCE_GENERATION_FAILED',
      message: 'Impossible de generer une reference Mobile Money unique',
    });
  }

  async findByReference(reference: string): Promise<Transaction> {
    const transaction = await this.repository.findByReference(reference);
    if (!transaction || transaction.paymentChannel !== PaymentChannel.MOBILE_MONEY) {
      throw new NotFoundException({
        error: 'MOBILE_MONEY_TRANSACTION_NOT_FOUND',
        message: `Aucune transaction Mobile Money pour la reference ${reference}`,
      });
    }
    return transaction;
  }

  async findByAggregatorReference(aggregatorReference: string): Promise<Transaction> {
    const transaction = await this.repository.findByAggregatorReference(aggregatorReference);
    if (!transaction || transaction.paymentChannel !== PaymentChannel.MOBILE_MONEY) {
      throw new NotFoundException({
        error: 'AGGREGATOR_TRANSACTION_NOT_FOUND',
        message: `Aucune transaction pour la reference agregateur ${aggregatorReference}`,
      });
    }
    return transaction;
  }

  /**
   * Enregistre la confirmation et prend atomiquement le droit d'appeler SOAP.
   * Une seconde notification ne peut pas franchir le predicat NOT_STARTED.
   *
   * Le controle du montant est realise **ici**, avec la transition d'etat :
   * place dans l'appelant, il pourrait etre contourne par un autre chemin.
   */
  async confirmAndClaimBankProcessing(
    transaction: Transaction,
    webhook: MobileMoneyWebhookDto,
    onClaimed?: (claimed: Transaction, manager: EntityManager) => Promise<void>,
  ): Promise<{ transaction: Transaction; claimed: boolean }> {
    // Garde-fou : la banque ne doit jamais etre instruite d'un montant que
    // l'agregateur n'a pas confirme. Le rapprochement final verifie la meme
    // egalite, mais il intervient apres l'execution — trop tard pour empecher
    // un mouvement de fonds.
    if (
      !amountsMatch(webhook.amount, Number(transaction.amount)) ||
      !currenciesMatch(webhook.currency, transaction.currency)
    ) {
      return { transaction: await this.markAmountMismatch(transaction, webhook), claimed: false };
    }

    const before = stateOf(transaction);

    // La commission n'est acquise que sur un encaissement conforme : elle est
    // figee ici, avec la confirmation, et jamais recalculee ensuite. Un taux qui
    // evolue ne doit pas deplacer des ecritures comptables deja passees.
    const feeAmount = roundToCent(webhook.amount * this.config.feeRate);

    // La prise du droit d'appeler la banque et la consignation de la
    // confirmation sont indissociables : une prise sans fait laisserait un
    // trou dans le registre, precisement sur la transition qui autorise un
    // mouvement de fonds.
    return this.dataSource.transaction(async (manager) => {
      const outcome = await manager
        .createQueryBuilder()
        .update(Transaction)
        .set({
          providerStatus: ProviderStatus.CONFIRMED,
          aggregatorAmount: webhook.amount,
          aggregatorCurrency: webhook.currency,
          mobileMoneyConfirmedAt: new Date(webhook.occurredAt),
          feeAmount,
          bankStatus: BankProcessingStatus.PROCESSING,
          status: TransactionStatus.PROCESSING,
        })
        .where('id = :id', { id: transaction.id })
        .andWhere('bank_status = :bankStatus', {
          bankStatus: BankProcessingStatus.NOT_STARTED,
        })
        .andWhere('provider_status IN (:...statuses)', {
          statuses: [ProviderStatus.INITIATED, ProviderStatus.PENDING],
        })
        .execute();

      const updated = await manager.getRepository(Transaction).findOneByOrFail({
        id: transaction.id,
      });

      if (outcome.affected === 1) {
        // Controle a l'interieur de la transaction : une transition refusee
        // annule l'ecriture au lieu de la constater apres coup. Le registre
        // etant append-only, un etat impossible consigne ne se corrige plus.
        this.stateMachine.assertTransition(before, stateOf(updated), updated.reference);

        await this.events.record(
          {
            type: TransactionEventType.PROVIDER_CONFIRMED,
            transaction: updated,
            observedAmount: webhook.amount,
            observedCurrency: webhook.currency,
            detail: 'Encaissement fournisseur conforme a la commande',
          },
          manager,
        );

        // L'etat autorisant le mouvement bancaire et l'instruction a executer
        // doivent devenir visibles ensemble. Si la mise en file echoue, cette
        // transaction annule aussi la confirmation et le fait consigne ; un
        // rejeu du webhook peut alors reprendre proprement.
        await onClaimed?.(updated, manager);
      }

      return { transaction: updated, claimed: outcome.affected === 1 };
    });
  }

  /**
   * Consigne un ecart entre la commande et la confirmation de l'agregateur,
   * sans jamais instruire la banque.
   *
   * `bank_status` reste NOT_STARTED : aucun mouvement n'a eu lieu. La ligne
   * part en MISMATCH pour traitement humain — c'est typiquement un
   * remboursement du payeur qui s'impose, pas un virement.
   */
  private async markAmountMismatch(
    transaction: Transaction,
    webhook: MobileMoneyWebhookDto,
  ): Promise<Transaction> {
    const currencyDiverges = !currenciesMatch(webhook.currency, transaction.currency);
    const reason =
      `Commande ${Number(transaction.amount).toFixed(2)} ${transaction.currency}, ` +
      `confirmation ${Number(webhook.amount).toFixed(2)} ${webhook.currency}`;

    const before = stateOf(transaction);

    // Les trois faits consignes plus bas decrivent une meme decision. Les ecrire
    // hors transaction exposerait a n'en conserver qu'une partie : un ecart
    // constate sans dette ouverte, par exemple, serait un registre trompeur.
    return this.dataSource.transaction(async (manager) => {
      const outcome = await manager
        .createQueryBuilder()
        .update(Transaction)
        .set({
          // Le payeur a bien ete debite : la jambe fournisseur est un succes, et
          // le rester est ce qui rend l'obligation de remboursement lisible.
          providerStatus: ProviderStatus.CONFIRMED,
          aggregatorAmount: webhook.amount,
          aggregatorCurrency: webhook.currency,
          mobileMoneyConfirmedAt: new Date(webhook.occurredAt),

          // Refus assume d'instruire la banque, distinct d'un rejet subi.
          bankStatus: BankProcessingStatus.BLOCKED,

          // Le virement, lui, n'a pas eu lieu.
          status: TransactionStatus.FAILED,
          processedAt: new Date(),
          failureReason: 'Confirmation Mobile Money incoherente avec la commande',

          reconciliationStatus: currencyDiverges
            ? ReconciliationStatus.CURRENCY_MISMATCH
            : ReconciliationStatus.AMOUNT_MISMATCH,
          reconciliationReason: reason,

          // Encaisse sans contrepartie livree : une dette est nee.
          refundStatus: RefundStatus.REQUIRED,
          caseStatus: CaseStatus.MANUAL_REVIEW,
          caseReason: `Ecart entre commande et confirmation fournisseur. ${reason}`,
        })
        .where('id = :id', { id: transaction.id })
        .andWhere('bank_status = :bankStatus', {
          bankStatus: BankProcessingStatus.NOT_STARTED,
        })
        .execute();

      const updated = await manager.getRepository(Transaction).findOneByOrFail({
        id: transaction.id,
      });
      // Une autre notification a deja fait evoluer la transaction. Ne jamais
      // consigner un ecart qui n'a pas ete applique a l'etat courant.
      if (outcome.affected !== 1) return updated;

      this.stateMachine.assertTransition(before, stateOf(updated), updated.reference);

      this.logger.warn({
        event: 'mobile-money.amount-mismatch',
        reference: transaction.reference,
        orderedAmount: Number(transaction.amount),
        orderedCurrency: transaction.currency,
        confirmedAmount: Number(webhook.amount),
        confirmedCurrency: webhook.currency,
        detail: 'Instruction bancaire bloquee, remboursement requis',
      });

      // Trois faits distincts : ce qui a ete constate, ce qui a ete refuse, et ce
      // qui est desormais du. Les fondre en un seul rendrait l'historique moins
      // lisible qu'il ne doit l'etre pour trancher un litige.
      for (const [type, detail] of [
        [TransactionEventType.AMOUNT_MISMATCH_DETECTED, reason],
        [TransactionEventType.BANK_PROCESSING_BLOCKED, 'Instruction bancaire non emise'],
        [TransactionEventType.CASE_OPENED, 'Remboursement du payeur a instruire'],
      ] as const) {
        await this.events.record(
          {
            type,
            transaction: updated,
            observedAmount: webhook.amount,
            observedCurrency: webhook.currency,
            detail,
          },
          manager,
        );
      }

      return updated;
    });
  }

  async markProviderFailed(
    transaction: Transaction,
    webhook: MobileMoneyWebhookDto,
  ): Promise<Transaction> {
    const before = stateOf(transaction);

    // Le refus est une issue finale, donc immediatement close. Etat terminal et
    // cloture doivent apparaitre ensemble : la verification deduit de l'un que
    // l'autre est attendu, et conclurait sinon a une troncature du registre.
    return this.dataSource.transaction(async (manager) => {
      const outcome = await manager
        .createQueryBuilder()
        .update(Transaction)
        .set({
          providerStatus: ProviderStatus.FAILED,
          aggregatorAmount: webhook.amount,
          aggregatorCurrency: webhook.currency,
          status: TransactionStatus.FAILED,
          processedAt: new Date(),
          failureReason: webhook.failureReason ?? 'Paiement refuse par l operateur Mobile Money',

          // Rien n'a ete encaisse : il n'y a aucune jambe a rapprocher, aucune
          // dette envers le payeur, et donc aucun dossier a instruire. C'est un
          // echec propre — le confondre avec un litige noierait les vrais dossiers.
          reconciliationStatus: ReconciliationStatus.NOT_APPLICABLE,
          reconciliationReason: 'Aucun encaissement fournisseur : rien a rapprocher',
          refundStatus: RefundStatus.NOT_REQUIRED,
          caseStatus: CaseStatus.NONE,
        })
        .where('id = :id', { id: transaction.id })
        .andWhere('bank_status = :bankStatus', {
          bankStatus: BankProcessingStatus.NOT_STARTED,
        })
        .execute();

      const updated = await manager.getRepository(Transaction).findOneByOrFail({
        id: transaction.id,
      });
      if (outcome.affected !== 1) return updated;

      this.stateMachine.assertTransition(before, stateOf(updated), updated.reference);

      await this.events.record(
        {
          type: TransactionEventType.PROVIDER_FAILED,
          transaction: updated,
          observedAmount: webhook.amount,
          observedCurrency: webhook.currency,
          detail: webhook.failureReason ?? 'Paiement refuse par l operateur',
        },
        manager,
      );
      // Aucun fonds n'a ete encaisse et aucune jambe bancaire n'a ete lancee :
      // ce refus est une issue finale, donc sa synthese peut etre ancree.
      await this.events.closeCase(updated, 'Dossier clos apres refus de l operateur', manager);
      return updated;
    });
  }

  private assertBusinessRules(dto: CreateMobileMoneyTransactionDto): void {
    if (!this.business.allowedCurrencies.includes(dto.currency)) {
      throw new BadRequestException({
        error: 'CURRENCY_NOT_ALLOWED',
        message: `Devise ${dto.currency} non autorisee`,
      });
    }
    if (dto.amount > this.business.maxAmount) {
      throw new UnprocessableEntityException({
        error: 'AMOUNT_LIMIT_EXCEEDED',
        message: `Le montant depasse le plafond autorise de ${this.business.maxAmount}`,
      });
    }
    if (dto.creditorIban === this.config.settlementIban) {
      throw new UnprocessableEntityException({
        error: 'SAME_ACCOUNT_TRANSFER',
        message: 'Le compte de reglement et le compte beneficiaire doivent etre distincts',
      });
    }
  }
}
