import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { EvmAnchorClient } from '../src/blockchain/evm-anchor.client';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import {
  SoapCommunicationException,
  SoapFaultException,
} from '../src/soap/exceptions/soap.exceptions';
import { SoapClientService } from '../src/soap/soap-client.service';
import type { AmountInWordsResult } from '../src/soap/soap.types';
import { TransactionStatus } from '../src/transactions/enums/transaction-status.enum';

const DEBTOR_IBAN = 'FR7630006000011234567890189';
const CREDITOR_IBAN = 'DE89370400440532013000';
const ENDPOINT = 'https://www.dataaccess.com/webservicesserver/NumberConversion.wso';

const validPayload = (overrides: Record<string, unknown> = {}) => ({
  debtorIban: DEBTOR_IBAN,
  debtorName: 'Societe Kongo SARL',
  creditorIban: CREDITOR_IBAN,
  creditorName: 'ACME GmbH',
  amount: 1250.75,
  currency: 'EUR',
  endToEndLabel: 'Facture 2026-0042',
  ...overrides,
});

/** Reponse SOAP realiste, contenant volontairement un IBAN pour eprouver le masquage. */
const soapSuccess = (): AmountInWordsResult => ({
  amountInWords: 'one thousand two hundred and fifty dollars and seventy five cents',
  exchange: {
    operation: 'NumberToDollars',
    endpoint: ENDPOINT,
    rawRequest:
      `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
      `<NumberToDollars xmlns="http://www.dataaccess.com/webservicesserver/">` +
      `<dNum>1250.75</dNum><debtorIban>${DEBTOR_IBAN}</debtorIban>` +
      `</NumberToDollars></soap:Body></soap:Envelope>`,
    rawResponse:
      `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
      `<m:NumberToDollarsResponse xmlns:m="http://www.dataaccess.com/webservicesserver/">` +
      `<m:NumberToDollarsResult>one thousand two hundred and fifty dollars and seventy five cents</m:NumberToDollarsResult>` +
      `</m:NumberToDollarsResponse></soap:Body></soap:Envelope>`,
    durationMs: 412,
    attempts: 1,
  },
});

describe('Transfers (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  const convertAmountToWords = jest.fn<Promise<AmountInWordsResult>, [number]>();

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      // Le service externe est bouchonne : les tests restent hermetiques et
      // deterministes, y compris pour les scenarios de faute et de timeout.
      .overrideProvider(SoapClientService)
      .useValue({ convertAmountToWords, isReady: async () => true })
      .overrideProvider(EvmAnchorClient)
      .useValue({
        isReady: () => Promise.resolve(true),
        getBatch: () => Promise.resolve(null),
        anchorBatch: () =>
          Promise.resolve({
            txHash: `0x${'ab'.repeat(32)}`,
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
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    convertAmountToWords.mockReset();
    convertAmountToWords.mockResolvedValue(soapSuccess());
    await dataSource.query(
      'TRUNCATE TABLE transaction_events, audit_logs, transactions RESTART IDENTITY CASCADE',
    );
  });

  const post = (payload: object, headers: Record<string, string> = {}) => {
    const req = request(app.getHttpServer()).post('/api/v1/transfers').send(payload);
    for (const [key, value] of Object.entries(headers)) req.set(key, value);
    return req;
  };

  // ==========================================================================
  // Cas nominal
  // ==========================================================================

  describe('POST /api/v1/transfers', () => {
    it('initie un virement et renvoie 201 avec le montant en toutes lettres', async () => {
      const response = await post(validPayload()).expect(201);

      expect(response.body).toMatchObject({
        status: TransactionStatus.COMPLETED,
        debtorIbanMasked: 'FR76****0189',
        creditorIbanMasked: 'DE89****3000',
        creditorName: 'ACME GmbH',
        amount: 1250.75,
        currency: 'EUR',
        amountInWords: 'one thousand two hundred and fifty dollars and seventy five cents',
        soap: { operation: 'NumberToDollars', durationMs: 412, attempts: 1 },
      });
      expect(response.body.reference).toMatch(/^TRF-\d{8}-[0-9A-HJ-NP-Z]{8}$/);
    });

    it('ne restitue jamais un IBAN complet', async () => {
      const response = await post(validPayload()).expect(201);

      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain(DEBTOR_IBAN);
      expect(serialized).not.toContain(CREDITOR_IBAN);
    });

    it('normalise un IBAN saisi avec des espaces et en minuscules', async () => {
      const response = await post(
        validPayload({ debtorIban: 'fr76 3000 6000 0112 3456 7890 189' }),
      ).expect(201);

      expect(response.body.debtorIbanMasked).toBe('FR76****0189');
    });

    it('renvoie l identifiant de correlation fourni par l appelant', async () => {
      const correlationId = 'e2e-correlation-0001';

      const response = await post(validPayload(), { 'X-Correlation-Id': correlationId }).expect(
        201,
      );

      expect(response.headers['x-correlation-id']).toBe(correlationId);
      expect(response.body.correlationId).toBe(correlationId);
    });

    it('genere un identifiant de correlation en l absence d en-tete', async () => {
      const response = await post(validPayload()).expect(201);
      expect(response.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  // ==========================================================================
  // Validation
  // ==========================================================================

  describe('Validation des donnees', () => {
    it('refuse un IBAN dont la cle de controle est fausse', async () => {
      const response = await post(
        validPayload({ creditorIban: 'FR7630006000011234567890188' }),
      ).expect(400);

      expect(response.body.error).toBe('VALIDATION_ERROR');
      expect(response.body.message.join(' ')).toContain('IBAN valide');
    });

    it.each([
      ['montant negatif', { amount: -10 }],
      ['montant nul', { amount: 0 }],
      ['plus de deux decimales', { amount: 10.123 }],
      ['montant textuel', { amount: '1250.75' }],
    ])('refuse un %s', async (_cas, overrides) => {
      await post(validPayload(overrides)).expect(400);
    });

    it('refuse un champ non declare au contrat', async () => {
      const response = await post(validPayload({ montantCache: 999 })).expect(400);
      expect(response.body.message.join(' ')).toContain('montantCache');
    });

    it('refuse un champ obligatoire manquant', async () => {
      const { creditorName, ...incomplete } = validPayload();
      expect(creditorName).toBeDefined();

      await post(incomplete).expect(400);
    });

    it('refuse un libelle contenant des caracteres interdits', async () => {
      await post(validPayload({ endToEndLabel: '<script>alert(1)</script>' })).expect(400);
    });

    it('refuse une devise hors de la liste autorisee', async () => {
      const response = await post(validPayload({ currency: 'JPY' })).expect(400);
      expect(response.body.error).toBe('CURRENCY_NOT_ALLOWED');
    });

    it('refuse un montant au-dela du plafond configure', async () => {
      const response = await post(validPayload({ amount: 2_000_000 })).expect(422);
      expect(response.body.error).toBe('AMOUNT_LIMIT_EXCEEDED');
    });

    it('refuse un virement d un compte vers lui-meme', async () => {
      const response = await post(validPayload({ creditorIban: DEBTOR_IBAN })).expect(422);
      expect(response.body.error).toBe('SAME_ACCOUNT_TRANSFER');
    });

    it('renvoie une enveloppe d erreur complete', async () => {
      const response = await post(validPayload({ currency: 'JPY' })).expect(400);

      expect(response.body).toMatchObject({
        statusCode: 400,
        error: 'CURRENCY_NOT_ALLOWED',
        path: '/api/v1/transfers',
      });
      expect(response.body.correlationId).toBeDefined();
      expect(Date.parse(response.body.timestamp)).not.toBeNaN();
    });

    it('n appelle pas le service externe quand la validation echoue', async () => {
      await post(validPayload({ currency: 'JPY' })).expect(400);
      expect(convertAmountToWords).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Idempotence
  // ==========================================================================

  describe('Idempotence', () => {
    it('un rejeu avec la meme cle renvoie la transaction initiale sans nouvel appel SOAP', async () => {
      const headers = { 'Idempotency-Key': 'e2e-idem-0001' };

      const first = await post(validPayload(), headers).expect(201);
      const second = await post(validPayload(), headers).expect(201);

      expect(second.body.reference).toBe(first.body.reference);
      expect(convertAmountToWords).toHaveBeenCalledTimes(1);
    });

    it('deux cles differentes produisent deux transactions distinctes', async () => {
      const first = await post(validPayload(), { 'Idempotency-Key': 'e2e-idem-A' }).expect(201);
      const second = await post(validPayload(), { 'Idempotency-Key': 'e2e-idem-B' }).expect(201);

      expect(second.body.reference).not.toBe(first.body.reference);
      expect(convertAmountToWords).toHaveBeenCalledTimes(2);
    });
  });

  // ==========================================================================
  // Echecs de l'integration SOAP
  // ==========================================================================

  describe('Echecs du service externe', () => {
    it('traduit une faute SOAP en 502 et laisse la transaction consultable', async () => {
      convertAmountToWords.mockRejectedValue(
        new SoapFaultException(
          {
            soapVersion: '1.1',
            faultCode: 'soap:Server',
            faultString: 'Server was unable to process request.',
          },
          'NumberToDollars',
          '<soap:Fault><faultcode>soap:Server</faultcode></soap:Fault>',
        ),
      );

      const failure = await post(validPayload()).expect(502);

      expect(failure.body).toMatchObject({
        error: 'SOAP_FAULT',
        details: { faultCode: 'soap:Server', soapVersion: '1.1' },
      });
      expect(failure.body.reference).toMatch(/^TRF-/);

      // La reference retournee dans l'erreur reste interrogeable.
      const lookup = await request(app.getHttpServer())
        .get(`/api/v1/transfers/${failure.body.reference}`)
        .expect(200);

      expect(lookup.body.status).toBe(TransactionStatus.FAILED);
      expect(lookup.body.soap.faultCode).toBe('soap:Server');
      expect(lookup.body.amountInWords).toBeUndefined();
    });

    it('traduit un depassement de delai en 504', async () => {
      convertAmountToWords.mockRejectedValue(
        new SoapCommunicationException(
          'timeout of 8000ms exceeded',
          'NumberToDollars',
          true,
          null,
          3,
        ),
      );

      const response = await post(validPayload()).expect(504);
      expect(response.body.error).toBe('SOAP_TIMEOUT');
    });

    it('traduit une indisponibilite reseau en 502', async () => {
      convertAmountToWords.mockRejectedValue(
        new SoapCommunicationException('getaddrinfo ENOTFOUND', 'NumberToDollars', false),
      );

      const response = await post(validPayload()).expect(502);
      expect(response.body.error).toBe('SOAP_UNAVAILABLE');
    });
  });

  // ==========================================================================
  // Consultation
  // ==========================================================================

  describe('GET /api/v1/transfers/:reference', () => {
    it('retourne le statut d une transaction existante', async () => {
      const created = await post(validPayload()).expect(201);

      const response = await request(app.getHttpServer())
        .get(`/api/v1/transfers/${created.body.reference}`)
        .expect(200);

      expect(response.body.reference).toBe(created.body.reference);
      expect(response.body.status).toBe(TransactionStatus.COMPLETED);
    });

    it('retourne 404 pour une reference inconnue', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/transfers/TRF-20260725-ZZZZZZZZ')
        .expect(404);

      expect(response.body.error).toBe('TRANSACTION_NOT_FOUND');
    });

    it('retourne 400 pour une reference mal formee', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/transfers/pas-une-reference')
        .expect(400);

      expect(response.body.message.join(' ')).toContain('TRF-YYYYMMDD-XXXXXXXX');
    });
  });

  describe('GET /api/v1/transfers', () => {
    it('pagine et filtre par statut', async () => {
      await post(validPayload()).expect(201);
      await post(validPayload({ amount: 42.5 })).expect(201);

      convertAmountToWords.mockRejectedValueOnce(
        new SoapCommunicationException('injoignable', 'NumberToDollars', false),
      );
      await post(validPayload({ amount: 99 })).expect(502);

      const all = await request(app.getHttpServer()).get('/api/v1/transfers').expect(200);
      expect(all.body.total).toBe(3);
      expect(all.body.page).toBe(1);
      expect(all.body.limit).toBe(20);
      expect(all.body.pages).toBe(1);

      const completed = await request(app.getHttpServer())
        .get('/api/v1/transfers?status=COMPLETED')
        .expect(200);
      expect(completed.body.total).toBe(2);

      const failed = await request(app.getHttpServer())
        .get('/api/v1/transfers?status=FAILED&limit=1')
        .expect(200);
      expect(failed.body.total).toBe(1);
      expect(failed.body.items).toHaveLength(1);
    });

    it('refuse un statut inconnu', async () => {
      await request(app.getHttpServer()).get('/api/v1/transfers?status=INEXISTANT').expect(400);
    });

    it('refuse une taille de page hors bornes', async () => {
      await request(app.getHttpServer()).get('/api/v1/transfers?limit=500').expect(400);
    });
  });

  // ==========================================================================
  // Piste d'audit
  // ==========================================================================

  describe('GET /api/v1/transfers/:reference/audit', () => {
    it('consigne la requete et la reponse SOAP', async () => {
      const created = await post(validPayload()).expect(201);

      const response = await request(app.getHttpServer())
        .get(`/api/v1/transfers/${created.body.reference}/audit`)
        .expect(200);

      // La piste s ouvre sur le document canonique valide contre son XSD,
      // puis retrace l aller-retour SOAP.
      expect(response.body).toHaveLength(3);
      expect(response.body[0]).toMatchObject({
        direction: 'DOCUMENT_VALIDATED',
        outcome: 'SUCCESS',
        operation: 'transfer-request.xsd',
      });
      expect(response.body[1]).toMatchObject({
        direction: 'OUTBOUND_REQUEST',
        outcome: 'SUCCESS',
        operation: 'NumberToDollars',
      });
      expect(response.body[2]).toMatchObject({
        direction: 'INBOUND_RESPONSE',
        outcome: 'SUCCESS',
        durationMs: 412,
      });
    });

    it('masque les IBAN presents dans les payloads XML consignes', async () => {
      const created = await post(validPayload()).expect(201);

      const response = await request(app.getHttpServer())
        .get(`/api/v1/transfers/${created.body.reference}/audit`)
        .expect(200);

      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain(DEBTOR_IBAN);
      expect(serialized).toContain('FR76****0189');
      // Le reste de l'enveloppe reste exploitable pour le diagnostic.
      expect(serialized).toContain('NumberToDollars');
    });

    it('consigne la faute SOAP', async () => {
      convertAmountToWords.mockRejectedValue(
        new SoapFaultException(
          { soapVersion: '1.1', faultCode: 'soap:Server', faultString: 'boom' },
          'NumberToDollars',
          '<soap:Fault><faultstring>boom</faultstring></soap:Fault>',
        ),
      );

      const failure = await post(validPayload()).expect(502);

      const response = await request(app.getHttpServer())
        .get(`/api/v1/transfers/${failure.body.reference}/audit`)
        .expect(200);

      expect(response.body).toHaveLength(2);
      expect(response.body[0]).toMatchObject({ direction: 'DOCUMENT_VALIDATED' });
      expect(response.body[1]).toMatchObject({
        direction: 'INBOUND_FAULT',
        outcome: 'FAULT',
        faultCode: 'soap:Server',
      });
    });

    it('retourne 404 pour une reference inconnue', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/transfers/TRF-20260725-ZZZZZZZZ/audit')
        .expect(404);
    });
  });

  // ==========================================================================
  // Supervision
  // ==========================================================================

  describe('GET /api/v1/health', () => {
    it('rapporte l etat des composants', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/health').expect(200);

      expect(response.body).toMatchObject({
        status: 'ok',
        components: { database: { status: 'up' }, soapClient: { status: 'up' } },
      });
    });
  });
});
