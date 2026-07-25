import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { EvmAnchorClient } from '../src/blockchain/evm-anchor.client';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { SoapClientService } from '../src/soap/soap-client.service';
import { E2E_AUTHORIZATION, E2E_READ_ONLY_AUTHORIZATION } from './setup-e2e';

const VALID_TRANSFER = {
  debtorIban: 'FR7630006000011234567890189',
  creditorIban: 'DE89370400440532013000',
  creditorName: 'ACME GmbH',
  amount: 1250.75,
  currency: 'EUR',
};

describe('Authentification (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SoapClientService)
      .useValue({
        convertAmountToWords: () =>
          Promise.resolve({
            amountInWords: 'mille deux cent cinquante',
            exchange: {
              operation: 'NumberToDollars',
              endpoint: 'https://example.test/soap',
              rawRequest: '<r/>',
              rawResponse: '<r/>',
              durationMs: 10,
              attempts: 1,
            },
          }),
        isReady: () => Promise.resolve(true),
      })
      .overrideProvider(EvmAnchorClient)
      .useValue({
        isReady: () => Promise.resolve(true),
        getBatch: () => Promise.resolve(null),
        anchorBatch: () => Promise.resolve({}),
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
  });

  afterAll(async () => {
    await app?.close();
  });

  const server = () => app.getHttpServer();

  // ==========================================================================

  describe('Refus par defaut', () => {
    it.each([
      ['POST', '/api/v1/transfers'],
      ['GET', '/api/v1/transfers'],
      ['GET', '/api/v1/transfers/TRF-20260725-8F3A2C71'],
      ['GET', '/api/v1/transfers/TRF-20260725-8F3A2C71/audit'],
      ['GET', '/api/v1/transfers/TRF-20260725-8F3A2C71/verification'],
      ['GET', '/api/v1/transfers/TRF-20260725-8F3A2C71/events'],
      ['GET', '/api/v1/transfers/TRF-20260725-8F3A2C71/events/verification'],
      ['GET', '/api/v1/anchors/batches'],
      ['POST', '/api/v1/anchors/batches'],
      ['GET', '/api/v1/anchors/statistics'],
      ['POST', '/api/v1/mobile-money/transactions'],
      ['GET', '/api/v1/mobile-money/transactions/TRF-20260725-8F3A2C71'],
      ['POST', '/api/v1/mobile-money/reconciliation/run'],
      ['GET', '/api/v1/simulator/mobile-money/payments/AGG-AUTH-0001'],
      ['POST', '/api/v1/simulator/mobile-money/payments/AGG-AUTH-0001/confirm'],
      ['GET', '/api/v1/transfers/TRF-20260725-8F3A2C71/refund'],
      ['POST', '/api/v1/transfers/TRF-20260725-8F3A2C71/refund'],
      ['POST', '/api/v1/transfers/TRF-20260725-8F3A2C71/refund/reopen'],
    ])('refuse %s %s sans cle', async (method, path) => {
      const response = await (method === 'POST'
        ? request(server()).post(path).send({})
        : request(server()).get(path));

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('UNAUTHENTICATED');
    });

    it('refuse une cle inconnue', async () => {
      const response = await request(server())
        .get('/api/v1/transfers')
        .set('Authorization', 'Bearer inconnu.secret')
        .expect(401);

      expect(response.body.error).toBe('UNAUTHENTICATED');
    });

    it('refuse un secret errone sur une cle connue', async () => {
      await request(server())
        .get('/api/v1/transfers')
        .set('Authorization', 'Bearer e2e.mauvais-secret')
        .expect(401);
    });

    it('ne revele pas si l identifiant existe', async () => {
      // Distinguer « cle inconnue » de « secret errone » permettrait d enumerer
      // les identifiants valides.
      const inconnu = await request(server())
        .get('/api/v1/transfers')
        .set('Authorization', 'Bearer inconnu.secret');
      const mauvais = await request(server())
        .get('/api/v1/transfers')
        .set('Authorization', 'Bearer e2e.mauvais');

      expect(inconnu.body.error).toBe(mauvais.body.error);
      expect(inconnu.body.message).toBe(mauvais.body.message);
    });
  });

  // ==========================================================================

  describe('Routes volontairement publiques', () => {
    it('laisse la sonde de sante accessible', async () => {
      await request(server()).get('/api/v1/health').expect(200);
    });

    it('laisse le webhook accessible : il porte sa propre signature HMAC', async () => {
      // Sans cle d API, mais rejete faute de signature valide — donc 401 de la
      // verification HMAC, et non 401 du garde de cle.
      const response = await request(server()).post('/api/v1/webhooks/mobile-money').send({
        eventId: 'EVT-AUTH-0001',
        aggregatorReference: 'AGG-AUTH-0001',
        status: 'CONFIRMED',
        amount: 10,
        currency: 'EUR',
        occurredAt: '2026-07-25T10:00:00.000Z',
      });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('INVALID_WEBHOOK_SIGNATURE');
    });
  });

  // ==========================================================================

  describe('Habilitations', () => {
    it('accepte une cle disposant de l habilitation requise', async () => {
      await request(server())
        .post('/api/v1/transfers')
        .set('Authorization', E2E_AUTHORIZATION)
        .send(VALID_TRANSFER)
        .expect(201);
    });

    it('accepte quelle que soit la casse du schema Bearer', async () => {
      await request(server())
        .get('/api/v1/transfers')
        .set('Authorization', E2E_AUTHORIZATION.replace('Bearer', 'bearer'))
        .expect(200);
    });

    it('refuse une cle valide depourvue de l habilitation requise', async () => {
      const response = await request(server())
        .post('/api/v1/mobile-money/reconciliation/run')
        .set('Authorization', E2E_READ_ONLY_AUTHORIZATION)
        .expect(403);

      expect(response.body.error).toBe('INSUFFICIENT_SCOPE');
      expect(response.body.message).toContain('reconciliation:write');
    });
  });
});
