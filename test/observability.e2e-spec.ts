import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource, QueryFailedError } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AnchorService } from '../src/blockchain/anchor.service';
import { EvmAnchorClient } from '../src/blockchain/evm-anchor.client';
import type { AnchorReceipt, OnChainBatch } from '../src/blockchain/evm-anchor.client';
import { verifyProof } from '../src/blockchain/merkle.util';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { RestoreVerificationService } from '../src/observability/restore-verification.service';
import { SoapClientService } from '../src/soap/soap-client.service';
import type { AmountInWordsResult } from '../src/soap/soap.types';
import { E2E_AUTHORIZATION } from './setup-e2e';

/** Tables append-only et declencheur qui les protege. */
const APPEND_ONLY_GUARDS: ReadonlyArray<[table: string, trigger: string]> = [
  ['journal_lines', 'trg_journal_lines_append_only'],
  ['journal_entries', 'trg_journal_entries_append_only'],
  ['transaction_events', 'trg_transaction_events_append_only'],
];

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

/** Registre en memoire reproduisant le contrat AuditAnchor. */
class InMemoryChain {
  readonly batches = new Map<string, OnChainBatch>();
  available = true;

  anchorBatch(batchId: string, merkleRoot: string, leafCount: number): AnchorReceipt {
    if (!this.available) throw new Error('noeud injoignable');
    this.batches.set(batchId, {
      merkleRoot,
      leafCount,
      anchoredAt: new Date(),
      submitter: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    });
    return {
      txHash: `0x${'ef'.repeat(32)}`,
      blockNumber: '1',
      gasUsed: '121159',
      chainId: '31337',
      contractAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    };
  }

  getBatch(batchId: string): OnChainBatch | null {
    if (!this.available) throw new Error('noeud injoignable');
    return this.batches.get(batchId) ?? null;
  }

  verifyInclusion(batchId: string, leaf: string, proof: readonly string[]): boolean {
    const batch = this.batches.get(batchId);
    return batch ? verifyProof(leaf, proof, batch.merkleRoot) : false;
  }
}

/**
 * Exploitation : sondes, metriques et controle de restauration.
 *
 * Ces tests portent sur des signaux, non sur des donnees metier. La tentation
 * serait de les eprouver sur une base vide — ils passeraient, sans rien prouver.
 * Chaque scenario ci-dessous produit donc un etat metier reel avant de lire le
 * signal qui doit le refleter.
 */
describe('Exploitation (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let anchorService: AnchorService;
  const chain = new InMemoryChain();
  const convertAmountToWords = jest.fn<Promise<AmountInWordsResult>, [number]>();

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SoapClientService)
      .useValue({ convertAmountToWords, isReady: async () => true })
      .overrideProvider(EvmAnchorClient)
      .useValue({
        anchorBatch: (id: string, root: string, count: number) =>
          Promise.resolve(chain.anchorBatch(id, root, count)),
        getBatch: (id: string) => Promise.resolve(chain.getBatch(id)),
        verifyInclusion: (id: string, leaf: string, proof: string[]) =>
          Promise.resolve(chain.verifyInclusion(id, leaf, proof)),
        isReady: () => Promise.resolve(chain.available),
        getSubmitterAddress: () => Promise.resolve('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'),
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
    anchorService = app.get(AnchorService);
  });

  afterAll(async () => {
    await app?.close();
  });

  const resetDatabase = async (): Promise<void> => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await dataSource.query(
          'TRUNCATE TABLE journal_lines, journal_entries, refunds, transaction_events, ' +
            'audit_logs, transactions, anchor_batches, mobile_money_webhook_events ' +
            'RESTART IDENTITY CASCADE',
        );
        return;
      } catch (error) {
        const driverError =
          error instanceof QueryFailedError ? (error.driverError as { code?: unknown }) : undefined;
        if (driverError?.code !== '40P01' || attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 25));
      }
    }
  };

  beforeEach(async () => {
    convertAmountToWords.mockReset();
    convertAmountToWords.mockResolvedValue(soapSuccess());
    chain.available = true;
    chain.batches.clear();
    await resetDatabase();
  });

  // ==========================================================================

  const initiate = async (amount: number): Promise<{ reference: string; aggregator: string }> => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/mobile-money/transactions')
      .set('Authorization', E2E_AUTHORIZATION)
      .send({
        operator: 'MPESA',
        payerMsisdn: '+243812345678',
        creditorIban: 'DE89370400440532013000',
        creditorName: 'Fournisseur Kinshasa',
        amount,
        currency: 'EUR',
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

  const metrics = async (): Promise<string> =>
    (await request(app.getHttpServer()).get('/api/v1/metrics').expect(200)).text;

  const valueOf = (exposition: string, series: string): number | null => {
    const line = exposition.split('\n').find((row) => row.startsWith(series));
    return line ? Number.parseFloat(line.slice(line.lastIndexOf(' ') + 1)) : null;
  };

  // ==========================================================================

  describe('Sondes', () => {
    it('la vivacite ne depend d aucune dependance externe', async () => {
      chain.available = false;

      // Le point decisif : un orchestrateur redemarre le conteneur quand cette
      // sonde echoue. La faire dependre d'un tiers reviendrait a redemarrer en
      // boucle un service sain, et a aggraver la panne a chaque reconnexion.
      const { body } = await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);

      expect(body.status).toBe('ok');
      expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    });

    it('l aptitude au trafic ignore la blockchain', async () => {
      chain.available = false;

      // L'ancrage est asynchrone et rattrapable : un noeud injoignable retarde
      // la publication des preuves, il n empeche ni d encaisser ni de payer.
      // Retirer le service du trafic pour cela couperait un systeme qui marche.
      const { body } = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);

      expect(body.status).toBe('ok');
      expect(body.components).toMatchObject({ database: 'up', xsdSchemas: 'up' });
      expect(body.components).not.toHaveProperty('blockchain');
    });

    it('les sondes restent joignables sans cle d API', async () => {
      // Un orchestrateur ne porte pas de secret applicatif.
      await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);
      await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);
      await request(app.getHttpServer()).get('/api/v1/metrics').expect(200);
    });
  });

  // ==========================================================================

  describe('Metriques', () => {
    it('chiffre la dette en cours et la garde equilibree', async () => {
      const { aggregator } = await initiate(1250.75);
      // Encaissement non conforme : 1200 preleves, virement bloque.
      await confirm(aggregator, 1200);

      const exposition = await metrics();

      expect(valueOf(exposition, 'gateway_debt_outstanding{currency="EUR"}')).toBe(1200);
      // Un desequilibre non nul serait une corruption, pas une derive.
      expect(valueOf(exposition, 'gateway_ledger_imbalance{currency="EUR"}')).toBe(0);
      expect(valueOf(exposition, 'gateway_cases_open')).toBe(1);
    });

    it('signale les preuves en retard de publication', async () => {
      const { aggregator } = await initiate(1250.75);
      await confirm(aggregator, 1250.75);

      const before = valueOf(await metrics(), 'gateway_events_unanchored');
      expect(before).toBeGreaterThan(0);

      await anchorService.processPendingBatch();

      // Des faits non ancres qui s accumulent signifient que l audit prend du
      // retard sur la realite — c est le signal, pas le nombre, qui compte.
      expect(valueOf(await metrics(), 'gateway_events_unanchored')).toBeLessThan(before as number);
    });

    it('mesure la latence du back-office', async () => {
      const { aggregator } = await initiate(1250.75);
      await confirm(aggregator, 1250.75);

      const exposition = await metrics();

      // Une metrique declaree mais jamais alimentee est pire qu'absente : elle
      // laisse croire que la latence est surveillee alors qu'aucune valeur ne
      // remonte. Ce test verrouille le cablage, pas la valeur.
      expect(exposition).toMatch(
        /gateway_soap_duration_seconds_count\{[^}]*outcome="success"[^}]*\} [1-9]/,
      );
    });

    it('n expose aucune donnee nominative', async () => {
      const { aggregator } = await initiate(1250.75);
      await confirm(aggregator, 1250.75);

      const exposition = await metrics();

      // Un collecteur ne porte pas de cle : l exposition doit rester agregee.
      expect(exposition).not.toContain('DE89370400440532013000');
      expect(exposition).not.toContain('+243812345678');
      expect(exposition).not.toMatch(/TRF-\d{8}-/);
    });
  });

  // ==========================================================================

  describe('Controle de restauration', () => {
    it('confirme une base fidele a ce qui est publie', async () => {
      const { aggregator } = await initiate(1250.75);
      await confirm(aggregator, 1250.75);
      await anchorService.processPendingBatch();

      const report = await app.get(RestoreVerificationService).verify();

      expect(report.verdict).toBe('CONSISTENT');
      expect(report.eventsMissing).toBe(0);
    });

    it('DETECTE une restauration anterieure au dernier ancrage', async () => {
      const { reference, aggregator } = await initiate(1250.75);
      await confirm(aggregator, 1250.75);
      await anchorService.processPendingBatch();

      // Simule une sauvegarde plus ancienne que la publication : les faits
      // ancres ont disparu de la base, alors que la chaine les atteste encore.
      //
      // Une restauration ne supprime rien — elle ne contient simplement pas ces
      // lignes. Les gardes append-only doivent donc etre levees pour reproduire
      // cet etat, qu'aucun chemin applicatif ne peut atteindre.
      for (const [table, trigger] of APPEND_ONLY_GUARDS) {
        await dataSource.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
      }
      try {
        await dataSource.query(
          `DELETE FROM journal_lines WHERE entry_id IN (
             SELECT id FROM journal_entries WHERE transaction_reference = $1)`,
          [reference],
        );
        await dataSource.query('DELETE FROM journal_entries WHERE transaction_reference = $1', [
          reference,
        ]);
        await dataSource.query(
          `DELETE FROM transaction_events WHERE transaction_reference = $1
             AND event_type = 'CASE_CLOSED'`,
          [reference],
        );
      } finally {
        for (const [table, trigger] of APPEND_ONLY_GUARDS) {
          await dataSource.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
        }
      }

      const report = await app.get(RestoreVerificationService).verify();

      expect(report.verdict).toBe('DATA_LOSS');
      expect(report.eventsMissing).toBeGreaterThan(0);
      // Le rapport doit orienter vers un rejeu de journaux, pas vers une
      // enquete : confondre les deux fait perdre un temps precieux.
      expect(report.findings.join(' ')).toContain('rejouez les journaux');
      expect(report.findings.join(' ')).toContain('les faits ne sont pas modifies, ils manquent');
    });

    it('refuse de conclure quand la chaine est injoignable', async () => {
      const { aggregator } = await initiate(1250.75);
      await confirm(aggregator, 1250.75);
      await anchorService.processPendingBatch();

      chain.available = false;
      const report = await app.get(RestoreVerificationService).verify();

      // Conclure « fidele » sans avoir pu interroger le temoin serait le pire
      // des rapports : il autoriserait une remise en service a l aveugle.
      expect(report.verdict).toBe('CHAIN_UNAVAILABLE');
      expect(report.findings.join(' ')).toContain('Ne remettez pas le service en ligne');
    });
  });
});
