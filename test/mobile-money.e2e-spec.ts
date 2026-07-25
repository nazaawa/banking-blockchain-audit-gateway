import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { E2E_AUTHORIZATION } from './setup-e2e';
import { EvmAnchorClient } from '../src/blockchain/evm-anchor.client';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { MobileMoneyWebhookStatus } from '../src/mobile-money/dto/mobile-money-webhook.dto';
import { MobileMoneyWebhookService } from '../src/mobile-money/mobile-money-webhook.service';
import {
  BankProcessingStatus,
  ProviderStatus,
  RefundStatus,
  CaseStatus,
  ReconciliationStatus,
} from '../src/mobile-money/enums/mobile-money.enum';
import { SoapClientService } from '../src/soap/soap-client.service';
import type { AmountInWordsResult } from '../src/soap/soap.types';

const payload = (overrides: Record<string, unknown> = {}) => ({
  operator: 'MPESA',
  payerMsisdn: '+243812345678',
  creditorIban: 'DE89370400440532013000',
  creditorName: 'ACME GmbH',
  amount: 1250.75,
  currency: 'EUR',
  externalReference: 'COMMANDE-2026-0042',
  ...overrides,
});

const soapSuccess = (): AmountInWordsResult => ({
  amountInWords: 'one thousand two hundred and fifty dollars and seventy five cents',
  exchange: {
    operation: 'NumberToDollars',
    endpoint: 'https://example.test/soap',
    rawRequest: '<request/>',
    rawResponse: '<response/>',
    durationMs: 20,
    attempts: 1,
  },
});

describe('Mobile Money (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let webhooks: MobileMoneyWebhookService;
  const convertAmountToWords = jest.fn<Promise<AmountInWordsResult>, [number]>();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SoapClientService)
      .useValue({ convertAmountToWords, isReady: async () => true })
      .overrideProvider(EvmAnchorClient)
      .useValue({
        isReady: () => Promise.resolve(true),
        getBatch: () => Promise.resolve(null),
        anchorBatch: () => Promise.reject(new Error('ancrage periodique desactive dans ce test')),
        verifyInclusion: () => Promise.resolve(true),
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    dataSource = app.get(getDataSourceToken());
    webhooks = app.get(MobileMoneyWebhookService);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    convertAmountToWords.mockReset();
    convertAmountToWords.mockResolvedValue(soapSuccess());
    await dataSource.query(
      'TRUNCATE TABLE transaction_events, mobile_money_webhook_events, audit_logs, transactions, anchor_batches RESTART IDENTITY CASCADE',
    );
  });

  async function initiate() {
    return request(app.getHttpServer())
      .post('/api/v1/mobile-money/transactions')
      .set('Authorization', E2E_AUTHORIZATION)
      .send(payload())
      .expect(201);
  }

  it('attend le webhook avant l appel bancaire', async () => {
    const response = await initiate();

    expect(response.body).toMatchObject({
      status: 'PENDING',
      providerStatus: ProviderStatus.PENDING,
      bankStatus: BankProcessingStatus.NOT_STARTED,
      reconciliationStatus: ReconciliationStatus.PENDING,
      payerMsisdnMasked: '+24****78',
      anchored: false,
    });
    expect(convertAmountToWords).not.toHaveBeenCalled();
  });

  it('confirme, appelle SOAP, rapproche puis consigne les faits au registre', async () => {
    const initiated = await initiate();
    const response = await request(app.getHttpServer())
      .post(`/api/v1/simulator/mobile-money/payments/${initiated.body.aggregatorReference}/confirm`)
      .set('Authorization', E2E_AUTHORIZATION)
      .send({})
      .expect(200);

    expect(response.body).toMatchObject({
      status: 'COMPLETED',
      providerStatus: ProviderStatus.CONFIRMED,
      bankStatus: BankProcessingStatus.COMPLETED,
      reconciliationStatus: ReconciliationStatus.MATCHED,
    });
    expect(convertAmountToWords).toHaveBeenCalledTimes(1);

    // La preuve n'est plus un instantane de la ligne : chaque fait du registre
    // porte la sienne, scellee des l'insertion.
    const events = await dataSource.query<Array<{ event_type: string; fingerprint: string }>>(
      'SELECT event_type, fingerprint FROM transaction_events WHERE transaction_reference = $1 ' +
        'ORDER BY sequence',
      [initiated.body.reference],
    );
    expect(events.map((e) => e.event_type)).toEqual(
      expect.arrayContaining(['PAYMENT_INITIATED', 'RECONCILIATION_MATCHED', 'CASE_CLOSED']),
    );
    expect(events.every((e) => /^0x[0-9a-f]{64}$/.test(e.fingerprint))).toBe(true);
  });

  it('consigne un ecart et n instruit jamais la banque', async () => {
    const initiated = await initiate();
    const response = await request(app.getHttpServer())
      .post(`/api/v1/simulator/mobile-money/payments/${initiated.body.aggregatorReference}/confirm`)
      .set('Authorization', E2E_AUTHORIZATION)
      .send({ amount: 1250.76 })
      .expect(200);

    // Les cinq dimensions decrivent desormais la situation reelle : le payeur a
    // ete debite, la banque n'a pas ete instruite, une dette est nee.
    expect(response.body).toMatchObject({
      providerStatus: ProviderStatus.CONFIRMED,
      bankStatus: BankProcessingStatus.BLOCKED,
      reconciliationStatus: ReconciliationStatus.AMOUNT_MISMATCH,
      refundStatus: RefundStatus.REQUIRED,
      caseStatus: CaseStatus.MANUAL_REVIEW,
    });

    const [stored] = await dataSource.query<
      Array<{ fingerprint: string | null; bank_status: string; refund_status: string }>
    >('SELECT fingerprint, bank_status, refund_status FROM transactions WHERE reference = $1', [
      initiated.body.reference,
    ]);

    // La preuve du litige vit desormais dans le registre append-only.
    const [{ count }] = await dataSource.query<Array<{ count: number }>>(
      'SELECT COUNT(*)::int AS count FROM transaction_events WHERE transaction_reference = $1',
      [initiated.body.reference],
    );
    expect(count).toBeGreaterThan(0);
    // Et la jambe bancaire n'est jamais partie sur un montant non confirme.
    expect(stored.bank_status).toBe(BankProcessingStatus.BLOCKED);
    expect(stored.refund_status).toBe(RefundStatus.REQUIRED);
  });

  it('deduplique une relivraison du meme evenement', async () => {
    const initiated = await initiate();
    const event = {
      eventId: 'EVT-E2E-IDEMPOTENT-0001',
      aggregatorReference: initiated.body.aggregatorReference as string,
      status: MobileMoneyWebhookStatus.CONFIRMED,
      amount: 1250.75,
      currency: 'EUR',
      occurredAt: '2026-07-25T10:12:33.827Z',
    };
    const signature = webhooks.sign(event);

    const deliver = () =>
      request(app.getHttpServer())
        .post('/api/v1/webhooks/mobile-money')
        .set('Authorization', E2E_AUTHORIZATION)
        .set('X-Mobile-Money-Signature', signature)
        .send(event);

    await deliver().expect(200);
    await deliver().expect(200);
    expect(convertAmountToWords).toHaveBeenCalledTimes(1);
  });

  it('refuse un webhook non authentifie', async () => {
    const initiated = await initiate();
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/mobile-money')
      .set('Authorization', E2E_AUTHORIZATION)
      .set('X-Mobile-Money-Signature', 'sha256=invalid')
      .send({
        eventId: 'EVT-E2E-INVALID-0001',
        aggregatorReference: initiated.body.aggregatorReference,
        status: MobileMoneyWebhookStatus.CONFIRMED,
        amount: 1250.75,
        currency: 'EUR',
        occurredAt: '2026-07-25T10:12:33.827Z',
      })
      .expect(401);
    expect(convertAmountToWords).not.toHaveBeenCalled();
  });

  it('n appelle pas SOAP et clot proprement apres un rejet operateur', async () => {
    const initiated = await initiate();
    const response = await request(app.getHttpServer())
      .post(`/api/v1/simulator/mobile-money/payments/${initiated.body.aggregatorReference}/confirm`)
      .set('Authorization', E2E_AUTHORIZATION)
      .send({ status: MobileMoneyWebhookStatus.FAILED })
      .expect(200);

    // Rien n'a ete encaisse : echec propre, sans dette ni dossier a instruire.
    expect(response.body).toMatchObject({
      providerStatus: ProviderStatus.FAILED,
      reconciliationStatus: ReconciliationStatus.NOT_APPLICABLE,
      refundStatus: RefundStatus.NOT_REQUIRED,
      caseStatus: CaseStatus.NONE,
    });
    expect(convertAmountToWords).not.toHaveBeenCalled();

    const events = await dataSource.query<Array<{ event_type: string }>>(
      'SELECT event_type FROM transaction_events WHERE transaction_reference = $1 ORDER BY sequence',
      [initiated.body.reference],
    );
    expect(events.at(-1)?.event_type).toBe('CASE_CLOSED');
  });
});
