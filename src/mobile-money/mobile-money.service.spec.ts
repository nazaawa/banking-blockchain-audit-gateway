import type { Repository } from 'typeorm';
import { Transaction } from '../transactions/entities/transaction.entity';
import { TransactionStatus } from '../transactions/enums/transaction-status.enum';
import { ReferenceGenerator } from '../transactions/reference.generator';
import { TransactionsRepository } from '../transactions/transactions.repository';
import { AggregatorSimulatorService } from './aggregator-simulator.service';
import { MobileMoneyWebhookDto, MobileMoneyWebhookStatus } from './dto/mobile-money-webhook.dto';
import {
  BankProcessingStatus,
  CaseStatus,
  PaymentChannel,
  ProviderStatus,
  ReconciliationStatus,
  RefundStatus,
} from './enums/mobile-money.enum';
import { MobileMoneyService } from './mobile-money.service';
import { TransactionEventsService } from '../events/transaction-events.service';

const ordered = (): Transaction =>
  Object.assign(new Transaction(), {
    id: 'tx-1',
    reference: 'TRF-20260725-8F3A2C71',
    aggregatorReference: 'AGG-1',
    paymentChannel: PaymentChannel.MOBILE_MONEY,
    status: TransactionStatus.PENDING,
    providerStatus: ProviderStatus.PENDING,
    bankStatus: BankProcessingStatus.NOT_STARTED,
    reconciliationStatus: ReconciliationStatus.PENDING,
    amount: 1250.75,
    currency: 'CDF',
  });

const webhook = (over: Partial<MobileMoneyWebhookDto> = {}): MobileMoneyWebhookDto => ({
  eventId: 'EVT-1',
  aggregatorReference: 'AGG-1',
  status: MobileMoneyWebhookStatus.CONFIRMED,
  amount: 1250.75,
  currency: 'CDF',
  occurredAt: '2026-07-25T10:12:33.827Z',
  ...over,
});

describe('MobileMoneyService — garde-fou sur le montant confirme', () => {
  let service: MobileMoneyService;
  let transactions: jest.Mocked<Repository<Transaction>>;
  let execute: jest.Mock;
  /** Derniere clause `.set(...)` soumise a la base. */
  let lastSet: Record<string, unknown>;
  let eventLedger: jest.Mocked<TransactionEventsService>;

  beforeEach(() => {
    execute = jest.fn(async () => ({ affected: 1 }));
    const builder: Record<string, unknown> = {};
    Object.assign(builder, {
      update: jest.fn(() => builder),
      set: jest.fn((patch: Record<string, unknown>) => {
        lastSet = patch;
        return builder;
      }),
      where: jest.fn(() => builder),
      andWhere: jest.fn(() => builder),
      execute,
    });

    transactions = {
      createQueryBuilder: jest.fn(() => builder),
      findOneByOrFail: jest.fn(async () => ordered()),
    } as unknown as jest.Mocked<Repository<Transaction>>;

    eventLedger = {
      record: jest.fn(async () => ({}) as never),
      closeCase: jest.fn(async () => null),
      findChain: jest.fn(async () => []),
      findLatest: jest.fn(async () => null),
    } as unknown as jest.Mocked<TransactionEventsService>;

    service = new MobileMoneyService(
      {} as TransactionsRepository,
      transactions,
      {} as ReferenceGenerator,
      {} as AggregatorSimulatorService,
      eventLedger,
      { allowedCurrencies: ['CDF'], maxAmount: 1_000_000 },
      { settlementIban: 'FR7630006000011234567890189' } as never,
    );
  });

  it('reclame le traitement bancaire quand la confirmation correspond a la commande', async () => {
    const result = await service.confirmAndClaimBankProcessing(ordered(), webhook());

    expect(result.claimed).toBe(true);
    expect(lastSet).toMatchObject({
      providerStatus: ProviderStatus.CONFIRMED,
      bankStatus: BankProcessingStatus.PROCESSING,
    });
  });

  it.each([
    ['paiement partiel', { amount: 1.0 }, ReconciliationStatus.AMOUNT_MISMATCH],
    ['montant superieur', { amount: 99999.99 }, ReconciliationStatus.AMOUNT_MISMATCH],
    ['ecart d un centime', { amount: 1250.74 }, ReconciliationStatus.AMOUNT_MISMATCH],
    ['devise differente', { currency: 'USD' }, ReconciliationStatus.CURRENCY_MISMATCH],
  ])('refuse la jambe bancaire sur %s', async (_cas, over, expectedReconciliation) => {
    const result = await service.confirmAndClaimBankProcessing(ordered(), webhook(over));

    // Aucune instruction bancaire : le droit d appeler SOAP n est pas accorde.
    expect(result.claimed).toBe(false);
    expect(lastSet).toMatchObject({
      // Le payeur a ete debite : la jambe fournisseur reste un succes.
      providerStatus: ProviderStatus.CONFIRMED,
      // Refus assume d instruire, distinct d un rejet subi.
      bankStatus: BankProcessingStatus.BLOCKED,
      // Le virement, lui, n a pas eu lieu.
      status: TransactionStatus.FAILED,
      reconciliationStatus: expectedReconciliation,
      // Encaisse sans contrepartie : une dette est nee, et un dossier s ouvre.
      refundStatus: RefundStatus.REQUIRED,
      caseStatus: CaseStatus.MANUAL_REVIEW,
    });
  });

  it('n efface jamais le succes du paiement fournisseur sur un ecart', async () => {
    await service.confirmAndClaimBankProcessing(ordered(), webhook({ amount: 1.0 }));

    // Marquer le fournisseur en echec effacerait le fait que le payeur a paye,
    // et donc l obligation de le rembourser.
    expect(lastSet.providerStatus).not.toBe(ProviderStatus.FAILED);
    expect(lastSet.providerStatus).toBe(ProviderStatus.CONFIRMED);
  });

  it('n ouvre ni dossier ni dette quand l operateur refuse le paiement', async () => {
    await service.markProviderFailed(
      ordered(),
      webhook({ status: MobileMoneyWebhookStatus.FAILED }),
    );

    // Rien n a ete encaisse : echec propre, aucune action humaine requise.
    expect(lastSet).toMatchObject({
      providerStatus: ProviderStatus.FAILED,
      reconciliationStatus: ReconciliationStatus.NOT_APPLICABLE,
      refundStatus: RefundStatus.NOT_REQUIRED,
      caseStatus: CaseStatus.NONE,
    });
    expect(eventLedger.closeCase).toHaveBeenCalledTimes(1);
  });

  it('conserve la trace des deux montants pour le traitement humain', async () => {
    await service.confirmAndClaimBankProcessing(ordered(), webhook({ amount: 1.0 }));

    expect(lastSet.aggregatorAmount).toBe(1.0);
    expect(String(lastSet.reconciliationReason)).toContain('1250.75');
    expect(String(lastSet.reconciliationReason)).toContain('1.00');
  });

  it('accepte deux ecritures equivalentes du meme montant', async () => {
    const transaction = Object.assign(ordered(), { amount: 1250.7 });
    const result = await service.confirmAndClaimBankProcessing(
      transaction,
      webhook({ amount: 1250.7 }),
    );

    expect(result.claimed).toBe(true);
  });

  it('n inscrit pas un faux ecart si une autre notification a deja traite la ligne', async () => {
    execute.mockResolvedValueOnce({ affected: 0 });

    const result = await service.confirmAndClaimBankProcessing(ordered(), webhook({ amount: 1.0 }));

    expect(result.claimed).toBe(false);
    expect(eventLedger.record).not.toHaveBeenCalled();
  });

  it('n inscrit pas un faux rejet fournisseur apres une transition concurrente', async () => {
    execute.mockResolvedValueOnce({ affected: 0 });

    await service.markProviderFailed(
      ordered(),
      webhook({ status: MobileMoneyWebhookStatus.FAILED }),
    );

    expect(eventLedger.record).not.toHaveBeenCalled();
    expect(eventLedger.closeCase).not.toHaveBeenCalled();
  });
});
