import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { EvmAnchorClient } from '../src/blockchain/evm-anchor.client';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { CaseStatus, RefundStatus } from '../src/mobile-money/enums/mobile-money.enum';
import { RefundsService } from '../src/refunds/refunds.service';
import { SoapClientService } from '../src/soap/soap-client.service';
import type { AmountInWordsResult } from '../src/soap/soap.types';
import { E2E_AUTHORIZATION } from './setup-e2e';

const soapSuccess = (): AmountInWordsResult => ({
  amountInWords: 'mille deux cent cinquante',
  exchange: {
    operation: 'NumberToDollars',
    endpoint: 'https://example.test/soap',
    rawRequest: '<r/>',
    rawResponse: '<r/>',
    durationMs: 15,
    attempts: 1,
  },
});

describe('Remboursement (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let refunds: RefundsService;
  const convertAmountToWords = jest.fn<Promise<AmountInWordsResult>, [number]>();

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SoapClientService)
      .useValue({ convertAmountToWords, isReady: async () => true })
      .overrideProvider(EvmAnchorClient)
      .useValue({
        isReady: () => Promise.resolve(true),
        getBatch: () => Promise.resolve(null),
        anchorBatch: () =>
          Promise.resolve({
            txHash: `0x${'ef'.repeat(32)}`,
            blockNumber: '1',
            gasUsed: '100000',
            chainId: '31337',
            contractAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
          }),
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

    dataSource = app.get<DataSource>(getDataSourceToken());
    refunds = app.get(RefundsService);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    convertAmountToWords.mockReset();
    convertAmountToWords.mockResolvedValue(soapSuccess());
    await dataSource.query(
      'TRUNCATE TABLE refunds, transaction_events, mobile_money_webhook_events, audit_logs, ' +
        'transactions, anchor_batches RESTART IDENTITY CASCADE',
    );
  });

  /** Cree un paiement puis provoque un ecart : une dette nait. */
  const withDebt = async (ordered = 1250.75, collected = 1.0): Promise<{ reference: string }> => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/mobile-money/transactions')
      .set('Authorization', E2E_AUTHORIZATION)
      .send({
        operator: 'MPESA',
        payerMsisdn: '+243812345678',
        creditorIban: 'DE89370400440532013000',
        creditorName: 'Fournisseur Kinshasa',
        amount: ordered,
        currency: 'EUR',
      })
      .expect(201);

    const [row] = await dataSource.query(
      'SELECT aggregator_reference FROM transactions WHERE reference = $1',
      [created.body.reference],
    );

    await request(app.getHttpServer())
      .post(`/api/v1/simulator/mobile-money/payments/${row.aggregator_reference}/confirm`)
      .set('Authorization', E2E_AUTHORIZATION)
      .send({ amount: collected })
      .expect(200);

    return { reference: created.body.reference as string };
  };

  const requestRefund = (reference: string) =>
    request(app.getHttpServer())
      .post(`/api/v1/transfers/${reference}/refund`)
      .set('Authorization', E2E_AUTHORIZATION);

  const eventsOf = async (reference: string) =>
    (
      await request(app.getHttpServer())
        .get(`/api/v1/transfers/${reference}/events`)
        .set('Authorization', E2E_AUTHORIZATION)
        .expect(200)
    ).body as Array<Record<string, any>>;

  // ==========================================================================

  describe('Montant restitue', () => {
    it('rembourse ce qui a ete encaisse, non ce qui avait ete commande', async () => {
      const { reference } = await withDebt(1250.75, 1.0);

      const response = await requestRefund(reference).expect(200);

      // Restituer 1250.75 enrichirait le payeur de 1249.75 qu il n a jamais verses.
      expect(Number(response.body.amount)).toBe(1.0);
      expect(response.body.status).toBe(RefundStatus.COMPLETED);
      expect(response.body.providerRefundReference).toMatch(/^RFN-/);
      expect(response.body).not.toHaveProperty('providerIdempotencyKey');
    });

    it('clot le dossier d exception une fois la dette eteinte', async () => {
      const { reference } = await withDebt();
      await requestRefund(reference).expect(200);

      const [row] = await dataSource.query(
        'SELECT refund_status, case_status FROM transactions WHERE reference = $1',
        [reference],
      );

      expect(row.refund_status).toBe(RefundStatus.COMPLETED);
      expect(row.case_status).toBe(CaseStatus.RESOLVED);
    });
  });

  // ==========================================================================

  describe('Idempotence', () => {
    it('un second appel renvoie le dossier abouti sans nouvelle sollicitation', async () => {
      const { reference } = await withDebt();

      const first = await requestRefund(reference).expect(200);
      const second = await requestRefund(reference).expect(200);

      expect(second.body.id).toBe(first.body.id);
      expect(second.body.providerRefundReference).toBe(first.body.providerRefundReference);
      // Une seule sollicitation du fournisseur, donc une seule tentative.
      expect(second.body.attempts).toBe(1);
    });

    it('n ouvre jamais deux dossiers pour une meme transaction', async () => {
      const { reference } = await withDebt();

      await Promise.all([requestRefund(reference), requestRefund(reference)]);

      const rows = await dataSource.query(
        'SELECT COUNT(*)::int AS count FROM refunds WHERE transaction_reference = $1',
        [reference],
      );
      expect(rows[0].count).toBe(1);
    });
  });

  // ==========================================================================

  describe('Echecs et reprise', () => {
    it('consigne un refus metier et laisse le dossier ouvert', async () => {
      // Le simulateur refuse les montants se terminant par .13
      const { reference } = await withDebt(1250.75, 10.13);

      const response = await requestRefund(reference).expect(200);

      expect(response.body.status).toBe(RefundStatus.FAILED);
      expect(response.body.lastError).toContain('Solde marchand insuffisant');

      const [row] = await dataSource.query(
        'SELECT case_status FROM transactions WHERE reference = $1',
        [reference],
      );
      // La dette n est pas eteinte : le dossier reste a instruire.
      expect(row.case_status).toBe(CaseStatus.MANUAL_REVIEW);
    });

    it('rouvre explicitement un refus metier et consigne le fait', async () => {
      const { reference } = await withDebt(1250.75, 10.13);
      await requestRefund(reference).expect(200);

      const reopened = await request(app.getHttpServer())
        .post(`/api/v1/transfers/${reference}/refund/reopen`)
        .set('Authorization', E2E_AUTHORIZATION)
        .expect(200);

      expect(reopened.body.status).toBe(RefundStatus.FAILED);
      expect(reopened.body.lastError).toBeUndefined();
      expect((await eventsOf(reference)).map((event) => event.eventType)).toContain(
        'REFUND_REOPENED',
      );

      const duplicate = await request(app.getHttpServer())
        .post(`/api/v1/transfers/${reference}/refund/reopen`)
        .set('Authorization', E2E_AUTHORIZATION)
        .expect(422);
      expect(duplicate.body.error).toBe('REFUND_ALREADY_RETRYABLE');
    });

    it('rejoue une indisponibilite sans jamais rembourser deux fois', async () => {
      // Le simulateur simule un timeout sur les montants se terminant par .99
      const { reference } = await withDebt(1250.75, 20.99);

      const failed = await requestRefund(reference).expect(200);
      expect(failed.body.status).toBe(RefundStatus.FAILED);
      const [beforeRetry] = await dataSource.query(
        'SELECT provider_idempotency_key FROM refunds WHERE transaction_reference = $1',
        [reference],
      );

      // Rejeu : la cle transmise au fournisseur reste la meme.
      const retried = await requestRefund(reference).expect(200);
      const [afterRetry] = await dataSource.query(
        'SELECT provider_idempotency_key FROM refunds WHERE transaction_reference = $1',
        [reference],
      );
      expect(retried.body.attempts).toBe(2);
      expect(afterRetry.provider_idempotency_key).toBe(beforeRetry.provider_idempotency_key);
      expect(retried.body).not.toHaveProperty('providerIdempotencyKey');
    });

    it('le declencheur de reprise traite les dossiers en attente', async () => {
      const { reference } = await withDebt(1250.75, 20.99);
      await requestRefund(reference).expect(200);

      const outcome = await refunds.retryPending();

      expect(outcome.examined).toBeGreaterThanOrEqual(1);
    });
  });

  // ==========================================================================

  describe('Refus', () => {
    it('refuse un remboursement sans dette', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/v1/mobile-money/transactions')
        .set('Authorization', E2E_AUTHORIZATION)
        .send({
          operator: 'MPESA',
          payerMsisdn: '+243812345678',
          creditorIban: 'DE89370400440532013000',
          creditorName: 'Fournisseur Kinshasa',
          amount: 500,
          currency: 'EUR',
        })
        .expect(201);

      const response = await requestRefund(created.body.reference as string).expect(422);
      expect(response.body.error).toBe('REFUND_NOT_REQUIRED');
    });

    it('refuse une reference inconnue', async () => {
      await requestRefund('TRF-20260725-ZZZZZZZZ').expect(404);
    });

    it('exige l habilitation refunds:write', async () => {
      const { reference } = await withDebt();

      await request(app.getHttpServer()).post(`/api/v1/transfers/${reference}/refund`).expect(401);
    });
  });

  // ==========================================================================

  describe('Registre des faits', () => {
    it('scelle REFUND_REQUESTED puis REFUND_COMPLETED', async () => {
      const { reference } = await withDebt();
      await requestRefund(reference).expect(200);

      const types = (await eventsOf(reference)).map((e) => e.eventType);

      expect(types).toEqual(expect.arrayContaining(['REFUND_REQUESTED', 'REFUND_COMPLETED']));
      expect(types.indexOf('REFUND_REQUESTED')).toBeLessThan(types.indexOf('REFUND_COMPLETED'));
    });

    it('scelle REFUND_FAILED sur un refus', async () => {
      const { reference } = await withDebt(1250.75, 10.13);
      await requestRefund(reference).expect(200);

      const types = (await eventsOf(reference)).map((e) => e.eventType);
      expect(types).toContain('REFUND_FAILED');
    });

    it('conserve la chaine intacte apres les faits de remboursement', async () => {
      const { reference } = await withDebt();
      await requestRefund(reference).expect(200);

      const report = (
        await request(app.getHttpServer())
          .get(`/api/v1/transfers/${reference}/verification`)
          .set('Authorization', E2E_AUTHORIZATION)
          .expect(200)
      ).body as Record<string, any>;

      expect(report.events.every((e: Record<string, any>) => e.chainIntact)).toBe(true);
      expect(report.events.every((e: Record<string, any>) => e.fingerprintMatches)).toBe(true);
    });
  });

  // ==========================================================================

  describe('Consultation', () => {
    it('expose le statut du remboursement', async () => {
      const { reference } = await withDebt();
      await requestRefund(reference).expect(200);

      const response = await request(app.getHttpServer())
        .get(`/api/v1/transfers/${reference}/refund`)
        .set('Authorization', E2E_AUTHORIZATION)
        .expect(200);

      expect(response.body).toMatchObject({
        transactionReference: reference,
        status: RefundStatus.COMPLETED,
        currency: 'EUR',
      });
    });

    it('retourne 404 tant qu aucun dossier n est ouvert', async () => {
      const { reference } = await withDebt();

      await request(app.getHttpServer())
        .get(`/api/v1/transfers/${reference}/refund`)
        .set('Authorization', E2E_AUTHORIZATION)
        .expect(404);
    });
  });
});
