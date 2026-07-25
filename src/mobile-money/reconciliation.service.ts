import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AnchorService } from '../blockchain/anchor.service';
import { Transaction } from '../transactions/entities/transaction.entity';
import {
  BankProcessingStatus,
  MobileMoneyStatus,
  PaymentChannel,
  ReconciliationStatus,
} from './enums/mobile-money.enum';

/** Compare les deux jambes du paiement et ne scelle que les resultats concordants. */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    @InjectRepository(Transaction)
    private readonly transactions: Repository<Transaction>,
    private readonly anchorService: AnchorService,
  ) {}

  async reconcile(transaction: Transaction): Promise<Transaction> {
    if (transaction.paymentChannel !== PaymentChannel.MOBILE_MONEY) return transaction;

    if (
      transaction.mobileMoneyStatus !== MobileMoneyStatus.CONFIRMED ||
      transaction.bankStatus !== BankProcessingStatus.COMPLETED
    ) {
      transaction.reconciliationStatus =
        transaction.bankStatus === BankProcessingStatus.FAILED
          ? ReconciliationStatus.MANUAL_REVIEW
          : ReconciliationStatus.PENDING;
      transaction.reconciliationReason =
        transaction.bankStatus === BankProcessingStatus.FAILED
          ? 'La confirmation Mobile Money existe mais le traitement bancaire a echoue'
          : 'Les deux jambes du paiement ne sont pas encore terminees';
      return this.transactions.save(transaction);
    }

    const amountMatches =
      this.toMinorUnits(transaction.aggregatorAmount) ===
      this.toMinorUnits(Number(transaction.amount));
    const currencyMatches = transaction.aggregatorCurrency === transaction.currency;

    transaction.reconciledAt = new Date();
    transaction.reconciliationStatus =
      amountMatches && currencyMatches
        ? ReconciliationStatus.MATCHED
        : ReconciliationStatus.MISMATCH;
    transaction.reconciliationReason =
      amountMatches && currencyMatches
        ? null
        : [
            amountMatches ? null : 'montant agregateur different du montant bancaire',
            currencyMatches ? null : 'devise agregateur differente de la devise bancaire',
          ]
            .filter(Boolean)
            .join('; ');

    const reconciled = await this.transactions.save(transaction);
    this.logger.log({
      event: 'mobile-money.reconciled',
      reference: reconciled.reference,
      reconciliationStatus: reconciled.reconciliationStatus,
    });

    // Le document final n'est construit et scelle qu'apres un MATCHED.
    return reconciled.reconciliationStatus === ReconciliationStatus.MATCHED
      ? this.anchorService.sealTransaction(reconciled)
      : reconciled;
  }

  /** Rejoue le rapprochement des lignes devenues eligibles apres une reprise. */
  async runPending(): Promise<{ examined: number; matched: number; mismatched: number }> {
    const pending = await this.transactions.find({
      where: {
        paymentChannel: PaymentChannel.MOBILE_MONEY,
        reconciliationStatus: ReconciliationStatus.PENDING,
        mobileMoneyStatus: MobileMoneyStatus.CONFIRMED,
        bankStatus: BankProcessingStatus.COMPLETED,
      },
      order: { createdAt: 'ASC' },
    });

    let matched = 0;
    let mismatched = 0;
    for (const transaction of pending) {
      const result = await this.reconcile(transaction);
      if (result.reconciliationStatus === ReconciliationStatus.MATCHED) matched += 1;
      if (result.reconciliationStatus === ReconciliationStatus.MISMATCH) mismatched += 1;
    }
    return { examined: pending.length, matched, mismatched };
  }

  private toMinorUnits(amount: number | null): number | null {
    return amount === null ? null : Math.round(Number(amount) * 100);
  }
}
