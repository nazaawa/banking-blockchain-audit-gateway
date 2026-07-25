import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { EvmAnchorClient } from '../src/blockchain/evm-anchor.client';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { MobileMoneyWebhookStatus } from '../src/mobile-money/dto/mobile-money-webhook.dto';
import { MobileMoneyWebhookService } from '../src/mobile-money/mobile-money-webhook.service';
import {
  BankProcessingStatus,
  MobileMoneyStatus,
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
      'TRUNCATE TABLE mobile_money_webhook_events, audit_logs, transactions, anchor_batches RESTART IDENTITY CASCADE',
    );
  });

  async function initiate() {
    return request(app.getHttpServer())
      .post('/api/v1/mobile-money/transactions')
      .send(payload())
      .expect(201);
  }

  it('attend le webhook avant l appel bancaire', async () => {
    const response = await initiate();

    expect(response.body).toMatchObject({
      status: 'PENDING',
      mobileMoneyStatus: MobileMoneyStatus.PENDING,
      bankStatus: BankProcessingStatus.NOT_STARTED,
      reconciliationStatus: ReconciliationStatus.PENDING,
      payerMsisdnMasked: '+24****78',
      anchored: false,
    });
    expect(convertAmountToWords).not.toHaveBeenCalled();
  });

  it('confirme, appelle SOAP, rapproche puis scelle le seul etat MATCHED', async () => {
    const initiated = await initiate();
    const response = await request(app.getHttpServer())
      .post(`/api/v1/simulator/mobile-money/payments/${initiated.body.aggregatorReference}/confirm`)
      .send({})
      .expect(200);

    expect(response.body).toMatchObject({
      status: 'COMPLETED',
      mobileMoneyStatus: MobileMoneyStatus.CONFIRMED,
      bankStatus: BankProcessingStatus.COMPLETED,
      reconciliationStatus: ReconciliationStatus.MATCHED,
    });
    expect(convertAmountToWords).toHaveBeenCalledTimes(1);

    const [stored] = await dataSource.query<Array<{ fingerprint: string | null }>>(
      'SELECT fingerprint FROM transactions WHERE reference = $1',
      [initiated.body.reference],
    );
    expect(stored.fingerprint).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('conserve un ecart non scelle pour investigation', async () => {
    const initiated = await initiate();
    const response = await request(app.getHttpServer())
      .post(`/api/v1/simulator/mobile-money/payments/${initiated.body.aggregatorReference}/confirm`)
      .send({ amount: 1250.76 })
      .expect(200);

    expect(response.body.reconciliationStatus).toBe(ReconciliationStatus.MISMATCH);
    const [stored] = await dataSource.query<Array<{ fingerprint: string | null }>>(
      'SELECT fingerprint FROM transactions WHERE reference = $1',
      [initiated.body.reference],
    );
    expect(stored.fingerprint).toBeNull();
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

  it('n appelle ni SOAP ni la blockchain apres un rejet operateur', async () => {
    const initiated = await initiate();
    const response = await request(app.getHttpServer())
      .post(`/api/v1/simulator/mobile-money/payments/${initiated.body.aggregatorReference}/confirm`)
      .send({ status: MobileMoneyWebhookStatus.FAILED })
      .expect(200);

    expect(response.body.mobileMoneyStatus).toBe(MobileMoneyStatus.FAILED);
    expect(response.body.reconciliationStatus).toBe(ReconciliationStatus.MANUAL_REVIEW);
    expect(convertAmountToWords).not.toHaveBeenCalled();
  });
});
