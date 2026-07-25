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
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';
import { getCorrelationId } from '../common/context/request-context';
import { businessConfig, mobileMoneyConfig } from '../config/configuration';
import { Transaction } from '../transactions/entities/transaction.entity';
import { TransactionStatus } from '../transactions/enums/transaction-status.enum';
import { ReferenceGenerator } from '../transactions/reference.generator';
import { TransactionsRepository } from '../transactions/transactions.repository';
import { AggregatorSimulatorService } from './aggregator-simulator.service';
import type { CreateMobileMoneyTransactionDto } from './dto/create-mobile-money-transaction.dto';
import type { MobileMoneyWebhookDto } from './dto/mobile-money-webhook.dto';
import {
  BankProcessingStatus,
  MobileMoneyStatus,
  PaymentChannel,
  ReconciliationStatus,
} from './enums/mobile-money.enum';

const MAX_REFERENCE_ATTEMPTS = 5;

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
        mobileMoneyStatus: MobileMoneyStatus.PENDING,
        bankStatus: BankProcessingStatus.NOT_STARTED,
        reconciliationStatus: ReconciliationStatus.PENDING,
      });

      try {
        const saved = await this.repository.save(transaction);
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
   */
  async confirmAndClaimBankProcessing(
    transaction: Transaction,
    webhook: MobileMoneyWebhookDto,
  ): Promise<{ transaction: Transaction; claimed: boolean }> {
    const outcome = await this.transactions
      .createQueryBuilder()
      .update(Transaction)
      .set({
        mobileMoneyStatus: MobileMoneyStatus.CONFIRMED,
        aggregatorAmount: webhook.amount,
        aggregatorCurrency: webhook.currency,
        mobileMoneyConfirmedAt: new Date(webhook.occurredAt),
        bankStatus: BankProcessingStatus.PROCESSING,
        status: TransactionStatus.PROCESSING,
      })
      .where('id = :id', { id: transaction.id })
      .andWhere('bank_status = :bankStatus', {
        bankStatus: BankProcessingStatus.NOT_STARTED,
      })
      .andWhere('mobile_money_status IN (:...statuses)', {
        statuses: [MobileMoneyStatus.INITIATED, MobileMoneyStatus.PENDING],
      })
      .execute();

    return {
      transaction: await this.transactions.findOneByOrFail({ id: transaction.id }),
      claimed: outcome.affected === 1,
    };
  }

  async markProviderFailed(
    transaction: Transaction,
    webhook: MobileMoneyWebhookDto,
  ): Promise<Transaction> {
    await this.transactions
      .createQueryBuilder()
      .update(Transaction)
      .set({
        mobileMoneyStatus: MobileMoneyStatus.FAILED,
        aggregatorAmount: webhook.amount,
        aggregatorCurrency: webhook.currency,
        status: TransactionStatus.FAILED,
        processedAt: new Date(),
        failureReason: webhook.failureReason ?? 'Paiement refuse par l operateur Mobile Money',
        reconciliationStatus: ReconciliationStatus.MANUAL_REVIEW,
        reconciliationReason: 'La jambe Mobile Money n a pas ete confirmee',
      })
      .where('id = :id', { id: transaction.id })
      .andWhere('bank_status = :bankStatus', {
        bankStatus: BankProcessingStatus.NOT_STARTED,
      })
      .execute();

    return this.transactions.findOneByOrFail({ id: transaction.id });
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
