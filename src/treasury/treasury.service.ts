import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { TransactionEventType } from '../events/enums/transaction-event.enum';
import { TransactionEvent } from '../events/entities/transaction-event.entity';
import { TransactionEventsService } from '../events/transaction-events.service';
import {
  PaymentChannel,
  ProviderStatus,
  ReconciliationStatus,
  RefundStatus,
} from '../mobile-money/enums/mobile-money.enum';
import { Transaction } from '../transactions/entities/transaction.entity';

export interface SweepOutcome {
  examined: number;
  swept: number;
  amount: number;
}

/**
 * Rapatriement des fonds detenus chez l'agregateur vers le compte de reglement.
 *
 * ## Pourquoi ce mouvement doit exister
 *
 * Sans lui, le compte de reglement ne serait jamais alimente et passerait en
 * negatif a chaque paiement du beneficiaire. Le journal resterait equilibre —
 * la partie double l'impose — mais il decrirait une tresorerie fausse.
 *
 * ## Pourquoi il est declenche, et non deduit
 *
 * L'agregateur ne notifie pas ses reversements : il les execute selon son propre
 * calendrier. Le deduire d'un autre fait reviendrait a inventer une observation.
 * Il est donc porte par une operation d'exploitation explicite, consignee au
 * registre comme n'importe quel autre fait — donc scellee, chainee et ancrable.
 */
@Injectable()
export class TreasuryService {
  private readonly logger = new Logger(TreasuryService.name);

  constructor(
    @InjectRepository(Transaction)
    private readonly transactions: Repository<Transaction>,
    private readonly events: TransactionEventsService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Rapatrie les encaissements qui ne l'ont pas encore ete.
   *
   * Idempotent : l'eligibilite se lit dans le registre lui-meme — une
   * transaction deja porteuse d'un `SETTLEMENT_SWEPT` est ecartee. Rejouer
   * l'operation ne cree donc aucun doublon, et aucun etat supplementaire n'a
   * besoin d'etre maintenu pour cela.
   */
  async sweep(limit = 100): Promise<SweepOutcome> {
    const eligible = await this.transactions
      .createQueryBuilder('transaction')
      .where('transaction.paymentChannel = :channel', { channel: PaymentChannel.MOBILE_MONEY })
      .andWhere('transaction.providerStatus = :confirmed', {
        confirmed: ProviderStatus.CONFIRMED,
      })
      .andWhere('transaction.reconciliationStatus = :matched', {
        matched: ReconciliationStatus.MATCHED,
      })
      .andWhere('transaction.refundStatus = :notRequired', {
        notRequired: RefundStatus.NOT_REQUIRED,
      })
      .andWhere('transaction.aggregatorAmount IS NOT NULL')
      .andWhere(
        `NOT EXISTS (
           SELECT 1 FROM transaction_events event
           WHERE event.transaction_reference = transaction.reference
             AND event.event_type = :swept
         )`,
        { swept: TransactionEventType.SETTLEMENT_SWEPT },
      )
      .orderBy('transaction.mobileMoneyConfirmedAt', 'ASC')
      .take(limit)
      .getMany();

    let swept = 0;
    let amount = 0;

    for (const transaction of eligible) {
      const collected = await this.dataSource.transaction(async (manager) => {
        // Deux operateurs peuvent lancer un balayage en meme temps. Le verrou
        // par transaction, suivi d'une relecture du registre, transforme cette
        // course en un seul fait comptable plutot qu'en deux rapatriements.
        const current = await manager.getRepository(Transaction).findOne({
          where: { reference: transaction.reference },
          lock: { mode: 'pessimistic_write' },
        });
        if (
          !current ||
          current.providerStatus !== ProviderStatus.CONFIRMED ||
          current.reconciliationStatus !== ReconciliationStatus.MATCHED ||
          current.refundStatus !== RefundStatus.NOT_REQUIRED ||
          current.aggregatorAmount === null
        ) {
          return null;
        }

        const alreadySwept = await manager.getRepository(TransactionEvent).exists({
          where: {
            transactionReference: current.reference,
            eventType: TransactionEventType.SETTLEMENT_SWEPT,
          },
        });
        if (alreadySwept) return null;

        const currentCollected = Number(current.aggregatorAmount);
        await this.events.record(
          {
            type: TransactionEventType.SETTLEMENT_SWEPT,
            transaction: current,
            observedAmount: currentCollected,
            observedCurrency: current.aggregatorCurrency,
            detail: `Rapatriement de ${currentCollected.toFixed(2)} ${current.currency}`,
          },
          manager,
        );
        return currentCollected;
      });

      if (collected === null) continue;
      swept += 1;
      amount = Math.round((amount + collected) * 100) / 100;
    }

    this.logger.log({
      event: 'treasury.sweep.completed',
      examined: eligible.length,
      swept,
      amount,
    });

    return { examined: eligible.length, swept, amount };
  }
}
