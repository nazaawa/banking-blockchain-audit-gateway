import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TransactionEventsService } from '../events/transaction-events.service';
import { TransactionEventType } from '../events/enums/transaction-event.enum';
import { amountsMatch, currenciesMatch } from './amount.util';
import { Transaction } from '../transactions/entities/transaction.entity';
import {
  BankProcessingStatus,
  ProviderStatus,
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
    private readonly events: TransactionEventsService,
  ) {}

  async reconcile(transaction: Transaction): Promise<Transaction> {
    if (transaction.paymentChannel !== PaymentChannel.MOBILE_MONEY) return transaction;

    // Rejeu apres un incident local survenu entre le verdict et la cloture :
    // ne pas recreer RECONCILIATION_MATCHED, mais reparer idempotemment la
    // preuve de synthese eventuellement manquante.
    if (transaction.reconciliationStatus === ReconciliationStatus.MATCHED) {
      await this.events.closeCase(transaction, 'Dossier clos apres rapprochement conforme');
      return transaction;
    }

    if (
      transaction.providerStatus !== ProviderStatus.CONFIRMED ||
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

    // Meme comparateur que le garde-fou pre-execution : les deux controles ne
    // doivent jamais pouvoir diverger.
    const amountMatches = amountsMatch(transaction.aggregatorAmount, Number(transaction.amount));
    const currencyMatches = currenciesMatch(transaction.aggregatorCurrency, transaction.currency);

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
    await this.events.record({
      type:
        reconciled.reconciliationStatus === ReconciliationStatus.MATCHED
          ? TransactionEventType.RECONCILIATION_MATCHED
          : TransactionEventType.RECONCILIATION_MISMATCH,
      transaction: reconciled,
      observedAmount: reconciled.aggregatorAmount,
      observedCurrency: reconciled.aggregatorCurrency,
      detail: reconciled.reconciliationReason,
    });
    // Un rapprochement conforme cloture le dossier : le virement a abouti et
    // rien d'autre n'est attendu. Un ecart, lui, laisse le dossier ouvert.
    if (reconciled.reconciliationStatus === ReconciliationStatus.MATCHED) {
      await this.events.closeCase(reconciled, 'Dossier clos apres rapprochement conforme');
    }

    this.logger.log({
      event: 'mobile-money.reconciled',
      reference: reconciled.reference,
      reconciliationStatus: reconciled.reconciliationStatus,
    });

    // La concordance est close ci-dessus. Un ecart reste ouvert jusqu'a
    // extinction de la dette envers le payeur ; seul ce futur etat final sera
    // ancre.
    return reconciled;
  }

  /** Rejoue le rapprochement des lignes devenues eligibles apres une reprise. */
  async runPending(): Promise<{ examined: number; matched: number; mismatched: number }> {
    const pending = await this.transactions.find({
      where: {
        paymentChannel: PaymentChannel.MOBILE_MONEY,
        reconciliationStatus: ReconciliationStatus.PENDING,
        providerStatus: ProviderStatus.CONFIRMED,
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
}
