import { Transaction } from '../transactions/entities/transaction.entity';
import { TransactionStatus } from '../transactions/enums/transaction-status.enum';
import {
  BankProcessingStatus,
  MobileMoneyOperator,
  ProviderStatus,
  PaymentChannel,
  ReconciliationStatus,
} from '../mobile-money/enums/mobile-money.enum';
import { TransferXmlBuilder } from '../xml/transfer-xml.builder';
import { XsdValidatorService } from '../xml/xsd-validator.service';
import { AnchorService } from './anchor.service';

/**
 * Couverture du scellement.
 *
 * Une issue terminale non scellee est une transaction sans preuve opposable.
 * Le flux classique scelle ses deux issues ; le flux Mobile Money doit en faire
 * autant pour chacune des siennes, y compris — surtout — les litiges.
 */
const base = (over: Partial<Transaction> = {}): Transaction =>
  Object.assign(new Transaction(), {
    id: 'tx-1',
    reference: 'TRF-20260725-8F3A2C71',
    paymentChannel: PaymentChannel.LEGACY_TRANSFER,
    status: TransactionStatus.COMPLETED,
    debtorIban: 'FR7630006000011234567890189',
    debtorName: 'Societe Kongo SARL',
    creditorIban: 'DE89370400440532013000',
    creditorName: 'ACME GmbH',
    amount: 1250.75,
    currency: 'CDF',
    endToEndLabel: null,
    amountInWords: 'mille deux cent cinquante',
    soapOperation: 'NumberToDollars',
    soapDurationMs: 42,
    soapAttempts: 1,
    faultCode: null,
    faultString: null,
    fingerprint: null,
    fingerprintSalt: null,
    correlationId: 'corr-1',
    reconciliationStatus: null,
    createdAt: new Date('2026-07-25T10:00:00.000Z'),
    processedAt: new Date('2026-07-25T10:00:01.000Z'),
    ...over,
  });

/**
 * Transaction Mobile Money confirmee et rapprochee.
 *
 * Les champs renseignes des l'initiation (operateur, MSISDN, reference
 * agregateur) sont toujours presents ; ceux qui dependent d'une notification
 * peuvent etre nuls selon l'issue, et chaque scenario les ajuste.
 */
const mobileMoney = (over: Partial<Transaction> = {}): Transaction =>
  base({
    paymentChannel: PaymentChannel.MOBILE_MONEY,
    mobileMoneyOperator: MobileMoneyOperator.MPESA,
    payerMsisdn: '+243810000000',
    aggregatorReference: 'AGG-20260725-A1B2C3D4',
    providerStatus: ProviderStatus.CONFIRMED,
    bankStatus: BankProcessingStatus.COMPLETED,
    aggregatorAmount: 1250.75,
    aggregatorCurrency: 'CDF',
    mobileMoneyConfirmedAt: new Date('2026-07-25T10:00:00.500Z'),
    reconciledAt: new Date('2026-07-25T10:00:02.000Z'),
    ...over,
  });

describe('AnchorService — couverture du scellement', () => {
  let service: AnchorService;
  let saved: Transaction[];

  beforeEach(() => {
    saved = [];
    const transactions = {
      save: jest.fn(async (t: Transaction) => {
        saved.push(t);
        return t;
      }),
    };

    service = new AnchorService(
      transactions as never,
      { create: jest.fn(), save: jest.fn() } as never,
      { update: jest.fn(), find: jest.fn() } as never, // registre d evenements
      {} as never, // DataSource — inutilise par sealTransaction
      new TransferXmlBuilder(),
      new XsdValidatorService(),
      {} as never, // EvmAnchorClient — l'ancrage n'est pas sollicite ici
      { addInterval: jest.fn() } as never,
      { enabled: false } as never,
      { batchMaxSize: 50, intervalMs: 15000, maxRetries: 3 },
    );
  });

  const isSealed = async (transaction: Transaction): Promise<boolean> => {
    const result = await service.sealTransaction(transaction);
    return result.fingerprint !== null;
  };

  describe('flux classique', () => {
    it.each([
      ['COMPLETED', TransactionStatus.COMPLETED],
      ['FAILED', TransactionStatus.FAILED],
    ])('scelle une transaction %s', async (_cas, status) => {
      await expect(isSealed(base({ status }))).resolves.toBe(true);
    });
  });

  describe('flux Mobile Money', () => {
    it('scelle un rapprochement conforme', async () => {
      await expect(
        isSealed(mobileMoney({ reconciliationStatus: ReconciliationStatus.MATCHED })),
      ).resolves.toBe(true);
    });

    it('scelle un ecart de montant — le dossier litigieux doit etre opposable', async () => {
      await expect(
        isSealed(
          mobileMoney({
            status: TransactionStatus.FAILED,
            bankStatus: BankProcessingStatus.NOT_STARTED,
            reconciliationStatus: ReconciliationStatus.MISMATCH,
            aggregatorAmount: 1.0,
            reconciledAt: null,
          }),
        ),
      ).resolves.toBe(true);
    });

    it('scelle un refus operateur, sans montant ni date de confirmation', async () => {
      await expect(
        isSealed(
          mobileMoney({
            status: TransactionStatus.FAILED,
            providerStatus: ProviderStatus.FAILED,
            bankStatus: BankProcessingStatus.NOT_STARTED,
            reconciliationStatus: ReconciliationStatus.MANUAL_REVIEW,
            // Refuse avant toute notification de montant : ces champs restent nuls.
            aggregatorAmount: null,
            aggregatorCurrency: null,
            mobileMoneyConfirmedAt: null,
            reconciledAt: null,
          }),
        ),
      ).resolves.toBe(true);
    });

    it('scelle un echec de la jambe bancaire', async () => {
      await expect(
        isSealed(
          mobileMoney({
            status: TransactionStatus.FAILED,
            bankStatus: BankProcessingStatus.FAILED,
            reconciliationStatus: ReconciliationStatus.MANUAL_REVIEW,
          }),
        ),
      ).resolves.toBe(true);
    });

    it('ne scelle pas tant que le rapprochement n est pas tranche', async () => {
      // PENDING : l'issue peut encore changer, la figer serait premature.
      await expect(
        isSealed(mobileMoney({ reconciliationStatus: ReconciliationStatus.PENDING })),
      ).resolves.toBe(false);
    });
  });

  describe('invariants', () => {
    it('ne scelle jamais un etat non terminal', async () => {
      await expect(isSealed(base({ status: TransactionStatus.PROCESSING }))).resolves.toBe(false);
      await expect(isSealed(base({ status: TransactionStatus.PENDING }))).resolves.toBe(false);
    });

    it('est idempotent : une transaction deja scellee n est pas rescellee', async () => {
      const transaction = base();
      const first = await service.sealTransaction(transaction);
      const fingerprint = first.fingerprint;

      const second = await service.sealTransaction(first);

      expect(second.fingerprint).toBe(fingerprint);
      expect(saved).toHaveLength(1);
    });
  });
});
