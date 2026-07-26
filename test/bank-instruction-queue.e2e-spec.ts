import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { BankInstructionWorker } from '../src/mobile-money/bank-instruction.worker';
import { BankInstructionStatus } from '../src/mobile-money/entities/bank-instruction.entity';
import { SoapClientService } from '../src/soap/soap-client.service';
import { SoapCommunicationException } from '../src/soap/exceptions/soap.exceptions';
import type { AmountInWordsResult } from '../src/soap/soap.types';
import { E2E_AUTHORIZATION } from './setup-e2e';

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
 * File des instructions bancaires : reprise, recul et abandon.
 *
 * Ces scenarios eprouvent le comportement en **panne**, pas en marche nominale.
 * C'est le seul moyen de savoir ce que le systeme fait quand le back-office
 * flanche — et ce qu'il fait alors engage de l'argent reellement encaisse.
 */
describe('File des instructions bancaires (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let worker: BankInstructionWorker;
  const convertAmountToWords = jest.fn<Promise<AmountInWordsResult>, [number]>();

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
    worker = app.get(BankInstructionWorker);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    convertAmountToWords.mockReset();
    convertAmountToWords.mockResolvedValue(soapSuccess());
    await dataSource.query(
      'TRUNCATE TABLE bank_instructions, journal_lines, journal_entries, refunds, ' +
        'transaction_events, audit_logs, transactions, anchor_batches, ' +
        'mobile_money_webhook_events RESTART IDENTITY CASCADE',
    );
  });

  // ==========================================================================

  const confirmedPayment = async (): Promise<string> => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/mobile-money/transactions')
      .set('Authorization', E2E_AUTHORIZATION)
      .send({
        operator: 'MPESA',
        payerMsisdn: '+243812345678',
        creditorIban: 'DE89370400440532013000',
        creditorName: 'Fournisseur Kinshasa',
        amount: 1250.75,
        currency: 'EUR',
      })
      .expect(201);

    const [row] = await dataSource.query<Array<{ aggregator_reference: string }>>(
      'SELECT aggregator_reference FROM transactions WHERE reference = $1',
      [created.body.reference],
    );

    await request(app.getHttpServer())
      .post(`/api/v1/simulator/mobile-money/payments/${row.aggregator_reference}/confirm`)
      .set('Authorization', E2E_AUTHORIZATION)
      .send({ amount: 1250.75 })
      .expect(200);

    return created.body.reference as string;
  };

  const instructionOf = async (
    reference: string,
  ): Promise<{ status: string; attempts: number; last_error: string | null }> => {
    const [row] = await dataSource.query<
      Array<{ status: string; attempts: number; last_error: string | null }>
    >(
      'SELECT status, attempts, last_error FROM bank_instructions WHERE transaction_reference = $1',
      [reference],
    );
    return row;
  };

  /** Rend la prochaine tentative immediatement eligible, sans attendre le recul. */
  const skipBackoff = (reference: string) =>
    dataSource.query(
      "UPDATE bank_instructions SET next_attempt_at = now() - interval '1 minute' " +
        'WHERE transaction_reference = $1',
      [reference],
    );

  const transactionOf = async (
    reference: string,
  ): Promise<{ bank_status: string; refund_status: string; case_status: string }> => {
    const [row] = await dataSource.query<
      Array<{ bank_status: string; refund_status: string; case_status: string }>
    >('SELECT bank_status, refund_status, case_status FROM transactions WHERE reference = $1', [
      reference,
    ]);
    return row;
  };

  // ==========================================================================

  describe('Decouplage', () => {
    it('acquitte le webhook sans avoir sollicite le back-office', async () => {
      const reference = await confirmedPayment();

      // L'agregateur a sa reponse. Le back-office n'a rien vu : c'est ce qui
      // l'empeche d'expirer et de rejouer une confirmation deja acquittee.
      expect(convertAmountToWords).not.toHaveBeenCalled();
      expect(await instructionOf(reference)).toMatchObject({
        status: BankInstructionStatus.PENDING,
        attempts: 0,
      });
    });

    it('execute puis marque l instruction aboutie', async () => {
      const reference = await confirmedPayment();

      const outcome = await worker.drain();

      expect(outcome).toMatchObject({ claimed: 1, completed: 1, deadLettered: 0 });
      expect(await instructionOf(reference)).toMatchObject({
        status: BankInstructionStatus.COMPLETED,
        attempts: 1,
      });
      expect((await transactionOf(reference)).bank_status).toBe('COMPLETED');
    });
  });

  // ==========================================================================

  describe('Reprise sur incident passager', () => {
    it('reprend une reclamation abandonnee par un processus interrompu', async () => {
      const reference = await confirmedPayment();
      await dataSource.query(
        `UPDATE bank_instructions
         SET status = 'IN_FLIGHT', updated_at = now() - interval '10 minutes'
         WHERE transaction_reference = $1`,
        [reference],
      );

      const outcome = await worker.drain();

      expect(outcome).toMatchObject({ claimed: 1, completed: 1 });
      expect(convertAmountToWords).toHaveBeenCalledTimes(1);
      expect(await instructionOf(reference)).toMatchObject({
        status: BankInstructionStatus.COMPLETED,
        attempts: 1,
      });
    });

    it('ne rejoue pas un resultat bancaire deja persiste avant l interruption', async () => {
      const reference = await confirmedPayment();
      await worker.drain();
      expect(convertAmountToWords).toHaveBeenCalledTimes(1);

      // Simule l'unique fenetre locale : le resultat metier a ete persiste,
      // mais le processus est tombe avant de solder la ligne de file.
      await dataSource.query(
        `UPDATE bank_instructions
         SET status = 'IN_FLIGHT', updated_at = now() - interval '10 minutes'
         WHERE transaction_reference = $1`,
        [reference],
      );

      await worker.drain();

      expect(convertAmountToWords).toHaveBeenCalledTimes(1);
      expect((await instructionOf(reference)).status).toBe(BankInstructionStatus.COMPLETED);
    });

    it('REJOUE un back-office momentanement injoignable au lieu d abandonner', async () => {
      const reference = await confirmedPayment();

      // Avant le decouplage, cette seule erreur condamnait le virement : jambe
      // bancaire en echec, dette envers le payeur, dossier a instruire. Pour un
      // hoquet reseau.
      convertAmountToWords.mockRejectedValueOnce(
        new SoapCommunicationException('connexion refusee', 'NumberToDollars', false, undefined, 3),
      );

      await worker.drain();
      const afterFailure = await instructionOf(reference);
      expect(afterFailure).toMatchObject({ status: BankInstructionStatus.PENDING, attempts: 1 });
      expect(afterFailure.last_error).toContain('connexion refusee');

      // Aucune dette n'est nee : l'issue n'est pas encore connue.
      expect(await transactionOf(reference)).toMatchObject({
        refund_status: 'NOT_REQUIRED',
        case_status: 'NONE',
      });

      await skipBackoff(reference);
      await worker.drain();

      expect(await instructionOf(reference)).toMatchObject({
        status: BankInstructionStatus.COMPLETED,
        attempts: 2,
      });
      expect((await transactionOf(reference)).bank_status).toBe('COMPLETED');
    });

    it('espace les tentatives par un recul exponentiel', async () => {
      const reference = await confirmedPayment();
      convertAmountToWords.mockRejectedValue(
        new SoapCommunicationException('indisponible', 'NumberToDollars', false, undefined, 3),
      );

      await worker.drain();

      const [row] = await dataSource.query<Array<{ delay_ms: string }>>(
        'SELECT (EXTRACT(EPOCH FROM (next_attempt_at - now())) * 1000)::text AS delay_ms ' +
          'FROM bank_instructions WHERE transaction_reference = $1',
        [reference],
      );

      // Rejouer immediatement un back-office en difficulte le maintiendrait en
      // difficulte : la tentative suivante est repoussee.
      expect(Number.parseFloat(row.delay_ms)).toBeGreaterThan(0);

      // Et tant que le recul court, la file ne rend rien.
      expect(await worker.drain()).toMatchObject({ claimed: 0 });
    });
  });

  // ==========================================================================

  describe('Abandon apres epuisement', () => {
    it('OUVRE une dette envers le payeur plutot que d abandonner en silence', async () => {
      const reference = await confirmedPayment();
      convertAmountToWords.mockRejectedValue(
        new SoapCommunicationException(
          'back-office hors service',
          'NumberToDollars',
          false,
          undefined,
          3,
        ),
      );

      // Quatre tentatives par defaut : on les epuise.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await skipBackoff(reference);
        await worker.drain();
      }

      expect(await instructionOf(reference)).toMatchObject({
        status: BankInstructionStatus.DEAD_LETTER,
        attempts: 4,
      });

      // Le point essentiel : le fournisseur a encaisse et le beneficiaire n'a
      // rien recu. Un echec definitif doit produire une **obligation**, pas
      // seulement une ligne de journal que personne ne relit.
      expect(await transactionOf(reference)).toMatchObject({
        refund_status: 'REQUIRED',
        case_status: 'MANUAL_REVIEW',
      });

      // Et le fait est consigne au registre, donc opposable.
      const events = await dataSource.query<Array<{ event_type: string }>>(
        'SELECT event_type FROM transaction_events WHERE transaction_reference = $1',
        [reference],
      );
      expect(events.map((event) => event.event_type)).toContain('CASE_OPENED');
    });

    it('n execute plus une instruction abandonnee', async () => {
      const reference = await confirmedPayment();
      convertAmountToWords.mockRejectedValue(
        new SoapCommunicationException('hors service', 'NumberToDollars', false, undefined, 3),
      );

      for (let attempt = 0; attempt < 4; attempt += 1) {
        await skipBackoff(reference);
        await worker.drain();
      }

      convertAmountToWords.mockResolvedValue(soapSuccess());
      const calls = convertAmountToWords.mock.calls.length;

      await skipBackoff(reference);
      await worker.drain();

      // Reprendre demande une decision humaine : le remboursement est deja
      expect(convertAmountToWords).toHaveBeenCalledTimes(calls);
      expect((await instructionOf(reference)).status).toBe(BankInstructionStatus.DEAD_LETTER);
    });

    it('expose les instructions abandonnees a la supervision', async () => {
      const reference = await confirmedPayment();
      convertAmountToWords.mockRejectedValue(
        new SoapCommunicationException('hors service', 'NumberToDollars', false, undefined, 3),
      );

      for (let attempt = 0; attempt < 4; attempt += 1) {
        await skipBackoff(reference);
        await worker.drain();
      }

      const dead = await worker.findDeadLettered();
      expect(dead.map((instruction) => instruction.transactionReference)).toContain(reference);
      expect(dead[0].retryable).toBe(false);
    });
  });

  // ==========================================================================

  describe('Concurrence', () => {
    it('ne laisse pas deux drainages executer la meme instruction', async () => {
      await confirmedPayment();

      // Deux travailleurs partent ensemble. `SKIP LOCKED` les departage : le
      // second ne doit pas doubler l'appel bancaire, donc le paiement.
      const [first, second] = await Promise.all([worker.drain(), worker.drain()]);

      expect(first.claimed + second.claimed).toBe(1);
      expect(convertAmountToWords).toHaveBeenCalledTimes(1);
    });
  });
});
