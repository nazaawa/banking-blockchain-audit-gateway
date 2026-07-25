import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { SoapClientService } from '../src/soap/soap-client.service';
import type { AmountInWordsResult } from '../src/soap/soap.types';
import { E2E_AUTHORIZATION } from './setup-e2e';

interface Balance {
  accounts: Array<{ account: string; debits: number; credits: number; balance: number }>;
  totalDebits: number;
  totalCredits: number;
  difference: number;
  entryCount: number;
}

const soapSuccess = (): AmountInWordsResult => ({
  amountInWords: 'mille deux cent cinquante',
  exchange: {
    operation: 'NumberToDollars',
    endpoint: 'https://example.test/soap',
    rawRequest: '<r/>',
    rawResponse: '<r/>',
    durationMs: 20,
    attempts: 1,
  },
});

/**
 * Comptabilite en partie double.
 *
 * Ce que ces tests eprouvent, au-dela du bon fonctionnement : qu'une dette porte
 * desormais un **montant** et non un drapeau. C'etait le manque exact du modele
 * a statuts — `refund_status = REQUIRED` disait qu'on devait quelque chose, sans
 * jamais dire combien.
 */
describe('Ledger en partie double (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  const convertAmountToWords = jest.fn<Promise<AmountInWordsResult>, [number]>();

  /** 1,5 % par defaut : la commission attendue sur un encaissement conforme. */
  const feeOn = (amount: number): number => Math.round(amount * 0.015 * 100) / 100;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SoapClientService)
      .useValue({ convertAmountToWords, isReady: async () => true })
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
      'TRUNCATE TABLE journal_lines, journal_entries, refunds, transaction_events, audit_logs, ' +
        'transactions, anchor_batches, mobile_money_webhook_events RESTART IDENTITY CASCADE',
    );
  });

  // ==========================================================================

  const initiate = async (
    amount: number,
    currency = 'EUR',
  ): Promise<{ reference: string; aggregator: string }> => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/mobile-money/transactions')
      .set('Authorization', E2E_AUTHORIZATION)
      .send({
        operator: 'MPESA',
        payerMsisdn: '+243812345678',
        creditorIban: 'DE89370400440532013000',
        creditorName: 'Fournisseur Kinshasa',
        amount,
        currency,
      })
      .expect(201);

    const [row] = await dataSource.query<Array<{ aggregator_reference: string }>>(
      'SELECT aggregator_reference FROM transactions WHERE reference = $1',
      [response.body.reference],
    );
    return { reference: response.body.reference as string, aggregator: row.aggregator_reference };
  };

  const confirm = (aggregator: string, amount: number) =>
    request(app.getHttpServer())
      .post(`/api/v1/simulator/mobile-money/payments/${aggregator}/confirm`)
      .set('Authorization', E2E_AUTHORIZATION)
      .send({ amount })
      .expect(200);

  const balance = async (reference?: string): Promise<Balance> =>
    (
      await request(app.getHttpServer())
        .get(`/api/v1/ledger/balance${reference ? `?reference=${reference}` : ''}`)
        .set('Authorization', E2E_AUTHORIZATION)
        .expect(200)
    ).body as Balance;

  const balanceOf = (report: Balance, account: string): number =>
    report.accounts.find((row) => row.account === account)?.balance ?? 0;

  const sweep = () =>
    request(app.getHttpServer())
      .post('/api/v1/treasury/sweeps')
      .set('Authorization', E2E_AUTHORIZATION)
      .send({})
      .expect(200);

  // ==========================================================================

  describe('Equilibre', () => {
    it('maintient debits = credits sur un paiement abouti', async () => {
      const { reference, aggregator } = await initiate(1250.75);
      await confirm(aggregator, 1250.75);

      const report = await balance(reference);

      expect(report.difference).toBe(0);
      expect(report.totalDebits).toBe(report.totalCredits);
      expect(report.entryCount).toBeGreaterThan(0);
    });

    it('REFUSE une ecriture desequilibree, meme en SQL direct', async () => {
      const { reference, aggregator } = await initiate(1250.75);
      await confirm(aggregator, 1250.75);

      const [entry] = await dataSource.query<Array<{ id: string }>>(
        'SELECT id FROM journal_entries WHERE transaction_reference = $1 LIMIT 1',
        [reference],
      );

      // Le declencheur est differe au commit : la transaction doit donc etre
      // explicite pour que le refus se produise, et non l'insertion isolee.
      await expect(
        dataSource.transaction(async (manager) => {
          await manager.query(
            `INSERT INTO journal_lines (entry_id, account, direction, amount)
             VALUES ($1, 'SETTLEMENT', 'DEBIT', 999.99)`,
            [entry.id],
          );
        }),
      ).rejects.toThrow(/desequilibree/);
    });
  });

  // ==========================================================================

  describe('Ce que le statut ne disait pas : le montant de la dette', () => {
    it('chiffre la dette envers le payeur sur un ecart de montant', async () => {
      const { reference, aggregator } = await initiate(1250.75);
      // L operateur n a preleve que 1200 : le virement ne partira pas.
      await confirm(aggregator, 1200);

      const report = await balance(reference);

      // C est tout l objet du ledger : `refund_status = REQUIRED` disait qu une
      // dette existait, sans jamais dire combien.
      expect(balanceOf(report, 'PAYER_PAYABLE')).toBe(1200);
      expect(balanceOf(report, 'PROVIDER_FLOAT')).toBe(1200);
      // Aucun service rendu, donc aucune commission acquise.
      expect(balanceOf(report, 'FEE_REVENUE')).toBe(0);
      expect(balanceOf(report, 'CREDITOR_PAYABLE')).toBe(0);
      expect(report.difference).toBe(0);
    });

    it('eteint la dette au centime pres apres remboursement', async () => {
      const { reference, aggregator } = await initiate(1250.75);
      await confirm(aggregator, 1200);

      await request(app.getHttpServer())
        .post(`/api/v1/transfers/${reference}/refund`)
        .set('Authorization', E2E_AUTHORIZATION)
        .send({})
        .expect(200);

      const report = await balance(reference);

      // Dette eteinte et fonds sortis : plus rien n est du, plus rien n est detenu.
      expect(balanceOf(report, 'PAYER_PAYABLE')).toBe(0);
      expect(balanceOf(report, 'PROVIDER_FLOAT')).toBe(0);
      expect(report.difference).toBe(0);
    });
  });

  // ==========================================================================

  describe('Commission', () => {
    it('acquiert la commission sur un service rendu', async () => {
      const { reference, aggregator } = await initiate(1250.75);
      await confirm(aggregator, 1250.75);

      const report = await balance(reference);
      const fee = feeOn(1250.75);

      expect(balanceOf(report, 'FEE_REVENUE')).toBe(fee);
      // Le beneficiaire a ete regle : la dette envers lui est eteinte.
      expect(balanceOf(report, 'CREDITOR_PAYABLE')).toBe(0);
      // Les fonds sont encore chez l agregateur, et le reglement a ete avance.
      expect(balanceOf(report, 'PROVIDER_FLOAT')).toBe(1250.75);
      expect(balanceOf(report, 'SETTLEMENT')).toBe(-(1250.75 - fee));
    });

    it('contre-passe la commission quand la banque echoue', async () => {
      convertAmountToWords.mockRejectedValue(new Error('back-office indisponible'));

      const { reference, aggregator } = await initiate(1250.75);
      await confirm(aggregator, 1250.75);

      const report = await balance(reference);

      // Le service n a pas ete rendu : facturer un echec serait indefendable.
      expect(balanceOf(report, 'FEE_REVENUE')).toBe(0);
      // L integralite est due au payeur, commission comprise.
      expect(balanceOf(report, 'PAYER_PAYABLE')).toBe(1250.75);
      expect(balanceOf(report, 'CREDITOR_PAYABLE')).toBe(0);
      expect(report.difference).toBe(0);
    });
  });

  // ==========================================================================

  describe('Tresorerie', () => {
    it('rapatrie les fonds et redresse le compte de reglement', async () => {
      const { reference, aggregator } = await initiate(1250.75);
      await confirm(aggregator, 1250.75);

      const outcome = await sweep();
      expect(outcome.body).toMatchObject({ swept: 1, amount: 1250.75 });

      const report = await balance(reference);
      const fee = feeOn(1250.75);

      // Les fonds ont quitte l agregateur pour le compte de reglement, qui porte
      // desormais ce qui reste apres reglement du beneficiaire : la commission.
      expect(balanceOf(report, 'PROVIDER_FLOAT')).toBe(0);
      expect(balanceOf(report, 'SETTLEMENT')).toBe(fee);
      expect(report.difference).toBe(0);
    });

    it('ne rapatrie jamais deux fois le meme encaissement', async () => {
      const { aggregator } = await initiate(1250.75);
      await confirm(aggregator, 1250.75);

      await sweep();
      const second = await sweep();

      // L eligibilite se lit dans le registre : aucun etat supplementaire n a
      // besoin d etre maintenu pour rendre l operation idempotente.
      expect(second.body).toMatchObject({ examined: 0, swept: 0 });
    });

    it('ne rapatrie pas les fonds qui doivent etre rembourses', async () => {
      const { aggregator } = await initiate(1250.75);
      await confirm(aggregator, 1200);

      const outcome = await sweep();

      expect(outcome.body).toMatchObject({ examined: 0, swept: 0, amount: 0 });
    });

    it('serialise deux balayages concurrents du meme encaissement', async () => {
      const { aggregator } = await initiate(1250.75);
      await confirm(aggregator, 1250.75);

      const outcomes = await Promise.all([sweep(), sweep()]);

      expect(outcomes.reduce((sum, result) => sum + result.body.swept, 0)).toBe(1);
      expect(outcomes.reduce((sum, result) => sum + result.body.amount, 0)).toBe(1250.75);
    });
  });

  describe('Devises', () => {
    it('refuse d additionner des balances globales de devises differentes', async () => {
      const eur = await initiate(100, 'EUR');
      await confirm(eur.aggregator, 100);
      const usd = await initiate(200, 'USD');
      await confirm(usd.aggregator, 200);

      await request(app.getHttpServer())
        .get('/api/v1/ledger/balance')
        .set('Authorization', E2E_AUTHORIZATION)
        .expect(400);

      const eurReport = (
        await request(app.getHttpServer())
          .get('/api/v1/ledger/balance?currency=EUR')
          .set('Authorization', E2E_AUTHORIZATION)
          .expect(200)
      ).body as Balance & { currency: string };

      expect(eurReport.currency).toBe('EUR');
      expect(eurReport.totalDebits).toBe(eurReport.totalCredits);
    });
  });

  // ==========================================================================

  describe('Tracabilite', () => {
    it('rattache chaque ecriture au fait qui la justifie', async () => {
      const { reference, aggregator } = await initiate(1250.75);
      await confirm(aggregator, 1250.75);

      const { body } = await request(app.getHttpServer())
        .get(`/api/v1/ledger/transfers/${reference}/entries`)
        .set('Authorization', E2E_AUTHORIZATION)
        .expect(200);

      const entries = body as Array<{ eventId: string; eventType: string; lines: unknown[] }>;
      expect(entries.length).toBeGreaterThan(0);
      // Le journal ne dit rien que le registre n atteste deja.
      expect(entries.every((entry) => entry.eventId)).toBe(true);
      expect(entries.every((entry) => entry.lines.length >= 2)).toBe(true);
    });

    it('n ecrit rien pour le virement classique, qui ne detient aucun fonds', async () => {
      const { body } = await request(app.getHttpServer())
        .post('/api/v1/transfers')
        .set('Authorization', E2E_AUTHORIZATION)
        .send({
          debtorIban: 'FR7630006000011234567890189',
          debtorName: 'Societe Kongo SARL',
          creditorIban: 'DE89370400440532013000',
          creditorName: 'ACME GmbH',
          amount: 1250.75,
          currency: 'EUR',
        })
        .expect(201);

      // Lui inventer une existence comptable serait faux : rien n est detenu.
      expect((await balance(body.reference as string)).entryCount).toBe(0);
    });
  });
});
