import type { Repository, UpdateResult } from 'typeorm';
import { AnchorService } from '../blockchain/anchor.service';
import { AuditService } from '../audit/audit.service';
import { SoapClientService } from '../soap/soap-client.service';
import type { AmountInWordsResult } from '../soap/soap.types';
import { Transaction } from '../transactions/entities/transaction.entity';
import { TransactionStatus } from '../transactions/enums/transaction-status.enum';
import { MobileMoneyWebhookDto, MobileMoneyWebhookStatus } from './dto/mobile-money-webhook.dto';
import { MobileMoneyWebhookEvent } from './entities/mobile-money-webhook-event.entity';
import {
  BankProcessingStatus,
  ProviderStatus,
  PaymentChannel,
  ReconciliationStatus,
} from './enums/mobile-money.enum';
import { MobileMoneyService } from './mobile-money.service';
import { MobileMoneyWebhookService } from './mobile-money-webhook.service';
import { ReconciliationService } from './reconciliation.service';
import { TransactionEventsService } from '../events/transaction-events.service';

const webhook = (): MobileMoneyWebhookDto => ({
  eventId: 'EVT-20260725-A1B2C3D4',
  aggregatorReference: 'AGG-20260725-A1B2C3D4',
  status: MobileMoneyWebhookStatus.CONFIRMED,
  amount: 1250.75,
  currency: 'CDF',
  occurredAt: '2026-07-25T10:12:33.827Z',
});

const transaction = (): Transaction =>
  Object.assign(new Transaction(), {
    id: '03f0ad77-e5b0-493d-b0eb-f055975c80bf',
    reference: 'TRF-20260725-8F3A2C71',
    aggregatorReference: 'AGG-20260725-A1B2C3D4',
    paymentChannel: PaymentChannel.MOBILE_MONEY,
    status: TransactionStatus.PROCESSING,
    providerStatus: ProviderStatus.CONFIRMED,
    bankStatus: BankProcessingStatus.PROCESSING,
    reconciliationStatus: ReconciliationStatus.PENDING,
    amount: 1250.75,
    currency: 'CDF',
    correlationId: 'b6f0c4a2-6a5f-4a13-9d2e-3f0c9e2a1b77',
  });

const soapSuccess = (): AmountInWordsResult => ({
  amountInWords: 'one thousand two hundred and fifty dollars',
  exchange: {
    operation: 'NumberToDollars',
    endpoint: 'https://example.test/soap',
    rawRequest: '<request/>',
    rawResponse: '<response/>',
    durationMs: 20,
    attempts: 1,
  },
});

describe('MobileMoneyWebhookService', () => {
  let service: MobileMoneyWebhookService;
  let events: jest.Mocked<Repository<MobileMoneyWebhookEvent>>;
  let transactions: jest.Mocked<Repository<Transaction>>;
  let mobileMoney: jest.Mocked<MobileMoneyService>;
  let soap: jest.Mocked<SoapClientService>;
  let audit: jest.Mocked<AuditService>;
  let reconciliation: jest.Mocked<ReconciliationService>;
  let anchor: jest.Mocked<AnchorService>;
  let eventLedger: jest.Mocked<TransactionEventsService>;

  beforeEach(() => {
    events = {
      create: jest.fn((value: Partial<MobileMoneyWebhookEvent>) =>
        Object.assign(new MobileMoneyWebhookEvent(), { id: 'event-id', ...value }),
      ),
      save: jest.fn(async (value: MobileMoneyWebhookEvent) => value),
      update: jest.fn(async () => ({ affected: 1 }) as UpdateResult),
      findOneByOrFail: jest.fn(),
    } as unknown as jest.Mocked<Repository<MobileMoneyWebhookEvent>>;
    transactions = {
      save: jest.fn(async (value: Transaction) => value),
    } as unknown as jest.Mocked<Repository<Transaction>>;
    mobileMoney = {
      findByAggregatorReference: jest.fn(async () => transaction()),
      confirmAndClaimBankProcessing: jest.fn(async (value: Transaction) => ({
        transaction: value,
        claimed: true,
      })),
      markProviderFailed: jest.fn(),
    } as unknown as jest.Mocked<MobileMoneyService>;
    soap = {
      convertAmountToWords: jest.fn(async () => soapSuccess()),
    } as unknown as jest.Mocked<SoapClientService>;
    audit = {
      record: jest.fn(async () => null),
    } as unknown as jest.Mocked<AuditService>;
    reconciliation = {
      reconcile: jest.fn(async (value: Transaction) => {
        value.reconciliationStatus = ReconciliationStatus.MATCHED;
        return value;
      }),
    } as unknown as jest.Mocked<ReconciliationService>;

    anchor = {
      sealTransaction: jest.fn(async (value: Transaction) => value),
    } as unknown as jest.Mocked<AnchorService>;

    eventLedger = {
      record: jest.fn(async () => ({}) as never),
      findChain: jest.fn(async () => []),
      findLatest: jest.fn(async () => null),
    } as unknown as jest.Mocked<TransactionEventsService>;

    service = new MobileMoneyWebhookService(
      events,
      transactions,
      mobileMoney,
      soap,
      audit,
      reconciliation,
      anchor,
      eventLedger,
      { webhookSecret: 'test-secret' } as never,
    );
  });

  it('refuse une signature invalide avant toute ecriture', async () => {
    await expect(service.handle(webhook(), 'sha256=invalid')).rejects.toMatchObject({
      status: 401,
    });
    expect(events.save).not.toHaveBeenCalled();
  });

  it('declenche SOAP puis le rapprochement apres confirmation signee', async () => {
    const payload = webhook();
    const result = await service.handle(payload, service.sign(payload));

    expect(soap.convertAmountToWords).toHaveBeenCalledWith(1250.75);
    expect(result.bankStatus).toBe(BankProcessingStatus.COMPLETED);
    expect(reconciliation.reconcile).toHaveBeenCalledTimes(1);
    expect(events.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ processingStatus: 'PROCESSED' }),
    );
  });

  it('libere la reclamation quand la transaction reste introuvable', async () => {
    // Course de commit : le callback devance la visibilite de la ligne.
    mobileMoney.findByAggregatorReference.mockRejectedValueOnce(new Error('transaction absente'));
    const payload = webhook();

    await expect(service.handle(payload, service.sign(payload))).rejects.toThrow(
      'transaction absente',
    );

    // Sans cette liberation, l evenement resterait PROCESSING et le rejeu de
    // l agregateur repartirait en « deja traite » : paiement confirme, virement
    // jamais execute, aucun signal.
    expect(events.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ processingStatus: 'FAILED' }),
    );
  });

  it('ne signe pas identiquement deux decoupages differents des memes champs', () => {
    // Sans prefixe de longueur, « EVT-1|AGG-VICTIME » + « X » et « EVT-1 » +
    // « AGG-VICTIME|X » produisaient la meme chaine canonique.
    const a = { ...webhook(), eventId: 'EVT-1|AGG-VICTIME', aggregatorReference: 'X' };
    const b = { ...webhook(), eventId: 'EVT-1', aggregatorReference: 'AGG-VICTIME|X' };

    expect(service.sign(a)).not.toBe(service.sign(b));
  });

  it('n appelle pas SOAP lorsqu une autre notification a deja pris la transaction', async () => {
    mobileMoney.confirmAndClaimBankProcessing.mockImplementation(async (value: Transaction) => ({
      transaction: value,
      claimed: false,
    }));
    const payload = webhook();

    await service.handle(payload, service.sign(payload));

    expect(soap.convertAmountToWords).not.toHaveBeenCalled();
    expect(reconciliation.reconcile).not.toHaveBeenCalled();
  });

  it('ne transforme pas un echec du registre en faux echec bancaire', async () => {
    eventLedger.record.mockRejectedValueOnce(new Error('registre indisponible'));
    const payload = webhook();

    await expect(service.handle(payload, service.sign(payload))).rejects.toThrow(
      'registre indisponible',
    );

    expect(transactions.save).toHaveBeenCalledTimes(1);
    expect(transactions.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: TransactionStatus.COMPLETED,
        bankStatus: BankProcessingStatus.COMPLETED,
      }),
    );
  });
});
