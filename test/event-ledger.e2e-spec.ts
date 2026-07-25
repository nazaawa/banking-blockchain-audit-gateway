import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { E2E_AUTHORIZATION } from './setup-e2e';
import { AnchorService } from '../src/blockchain/anchor.service';
import { EvmAnchorClient } from '../src/blockchain/evm-anchor.client';
import type { AnchorReceipt, OnChainBatch } from '../src/blockchain/evm-anchor.client';
import { verifyProof } from '../src/blockchain/merkle.util';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { SoapClientService } from '../src/soap/soap-client.service';
import type { AmountInWordsResult } from '../src/soap/soap.types';

interface EventBody {
  eventType: string;
  sequence: number;
  expectedAmount: number | string;
  observedAmount: number | string | null;
  previousFingerprint: string | null;
  fingerprint: string;
  anchorStatus: string;
  batchId: string | null;
  /** Renseignes sur le seul evenement de cloture. */
  closureEventCount: number | null;
  closureChainHead: string | null;
}

interface VerificationBody {
  verdict: string;
  closed: boolean;
  declaredEventCount: number | null;
  eventCount: number;
  anchoredCount: number;
  head: string | null;
  events: Array<{
    anchorVerified: boolean | null;
    fingerprintMatches: boolean;
  }>;
}

const withoutAppendOnlyGuard = async (
  dataSource: DataSource,
  mutation: () => Promise<unknown>,
): Promise<void> => {
  await dataSource.query(
    'ALTER TABLE transaction_events DISABLE TRIGGER trg_transaction_events_append_only',
  );
  try {
    await mutation();
  } finally {
    await dataSource.query(
      'ALTER TABLE transaction_events ENABLE TRIGGER trg_transaction_events_append_only',
    );
  }
};

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
  private block = 0;

  anchorBatch(batchId: string, merkleRoot: string, leafCount: number): AnchorReceipt {
    if (!this.available) throw new Error('noeud injoignable');
    if (this.batches.has(batchId)) throw new Error(`BatchAlreadyAnchored: ${batchId}`);
    this.batches.set(batchId, {
      merkleRoot,
      leafCount,
      anchoredAt: new Date(),
      submitter: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    });
    this.block += 1;
    return {
      txHash: `0x${'cd'.repeat(32)}`,
      blockNumber: String(this.block),
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

describe('Registre d evenements (e2e)', () => {
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
        getSubmitterAddress: () => '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
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

  beforeEach(async () => {
    convertAmountToWords.mockReset();
    convertAmountToWords.mockResolvedValue(soapSuccess());
    chain.available = true;
    chain.batches.clear();
    // TRUNCATE ne declenche pas les declencheurs de ligne : le nettoyage de test
    // reste possible, la protection append-only vise les DELETE applicatifs.
    await dataSource.query(
      'TRUNCATE TABLE transaction_events, audit_logs, transactions, anchor_batches, ' +
        'mobile_money_webhook_events RESTART IDENTITY CASCADE',
    );
  });

  const initiate = async (amount = 1250.75): Promise<{ reference: string; aggregator: string }> => {
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

  const chainOf = async (reference: string): Promise<EventBody[]> => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/transfers/${reference}/events`)
      .set('Authorization', E2E_AUTHORIZATION)
      .expect(200);
    return response.body as EventBody[];
  };

  const verifyChain = async (reference: string): Promise<VerificationBody> => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/transfers/${reference}/events/verification`)
      .set('Authorization', E2E_AUTHORIZATION)
      .expect(200);
    return response.body as VerificationBody;
  };

  // ==========================================================================

  describe('Consignation', () => {
    it('consigne, scelle et chaine chaque fait', async () => {
      const { reference, aggregator } = await initiate();
      await confirm(aggregator, 1250.75);

      const events = await chainOf(reference);

      expect(events.length).toBeGreaterThanOrEqual(4);
      expect(JSON.stringify(events)).not.toContain('fingerprintSalt');
      expect(events.map((e) => e.eventType)).toEqual(
        expect.arrayContaining([
          'PAYMENT_INITIATED',
          'PROVIDER_CONFIRMED',
          'BANK_PROCESSING_COMPLETED',
          'RECONCILIATION_MATCHED',
        ]),
      );

      // Chaque maillon pointe vers l empreinte du precedent.
      expect(events[0].previousFingerprint).toBeNull();
      for (let i = 1; i < events.length; i += 1) {
        expect(events[i].previousFingerprint).toBe(events[i - 1].fingerprint);
        expect(events[i].sequence).toBe(events[i - 1].sequence + 1);
      }
    });

    it('conserve les montants attendu et constate sur un ecart', async () => {
      const { reference, aggregator } = await initiate(1250.75);
      await confirm(aggregator, 1.0);

      const events = await chainOf(reference);
      const mismatch = events.find((e) => e.eventType === 'AMOUNT_MISMATCH_DETECTED');

      expect(mismatch).toBeDefined();
      expect(Number(mismatch?.expectedAmount)).toBe(1250.75);
      expect(Number(mismatch?.observedAmount)).toBe(1);
      // Le refus d instruire et l ouverture du dossier sont des faits distincts.
      expect(events.map((e) => e.eventType)).toEqual(
        expect.arrayContaining(['BANK_PROCESSING_BLOCKED', 'CASE_OPENED']),
      );
    });
  });

  // ==========================================================================

  describe('Immuabilite imposee par la base', () => {
    it('refuse la modification d un fait consigne', async () => {
      const { reference } = await initiate();

      await expect(
        dataSource.query('UPDATE transaction_events SET expected_amount = 1 WHERE $1 = $1', [
          reference,
        ]),
      ).rejects.toThrow(/append-only/);
    });

    it('refuse la suppression d un fait consigne', async () => {
      await initiate();

      await expect(dataSource.query('DELETE FROM transaction_events WHERE 1 = 1')).rejects.toThrow(
        /append-only/,
      );
    });

    it('autorise la mise a jour des seules colonnes d ancrage', async () => {
      await initiate();

      await expect(
        dataSource.query('UPDATE transaction_events SET leaf_index = 0'),
      ).resolves.toBeDefined();
    });
  });

  // ==========================================================================

  describe('Ancrage', () => {
    it('ancre transactions et evenements dans un meme lot', async () => {
      const { reference, aggregator } = await initiate();
      await confirm(aggregator, 1250.75);

      const outcome = await anchorService.processPendingBatch();

      expect(outcome.anchored).toBeGreaterThan(0);
      expect(chain.batches.size).toBe(1);

      const events = await chainOf(reference);
      expect(events.every((e) => e.anchorStatus === 'ANCHORED')).toBe(true);
      // Un seul lot couvre les deux natures d elements : le cout on-chain reste
      // celui d une unique ecriture de 32 octets.
      expect(events.every((e) => e.batchId === outcome.batch?.id)).toBe(true);
    });

    it('produit une preuve d inclusion valide pour chaque fait', async () => {
      const { reference, aggregator } = await initiate();
      await confirm(aggregator, 1250.75);
      await anchorService.processPendingBatch();

      const report = await verifyChain(reference);

      expect(report.verdict).toBe('VERIFIED');
      expect(report.anchoredCount).toBe(report.eventCount);
      expect(report.events.every((event) => event.anchorVerified === true)).toBe(true);
    });

    it('ancre aussi les faits d un dossier litigieux', async () => {
      const { reference, aggregator } = await initiate(1250.75);
      await confirm(aggregator, 1.0);

      await anchorService.processPendingBatch();
      const report = await verifyChain(reference);

      // C est le dossier qui a le plus besoin d une preuve opposable.
      expect(report.verdict).toBe('VERIFIED');
      expect(report.eventCount).toBeGreaterThanOrEqual(4);
    });
  });

  // ==========================================================================

  describe('Preuve de synthese', () => {
    it('clot le dossier apres un rapprochement conforme', async () => {
      const { reference, aggregator } = await initiate();
      await confirm(aggregator, 1250.75);

      const events = await chainOf(reference);
      const closing = events.find((e) => e.eventType === 'CASE_CLOSED');

      expect(closing).toBeDefined();
      // Le compte declare inclut la cloture elle-meme.
      expect(closing?.closureEventCount).toBe(events.length);
      // Le sommet declare est l empreinte du fait qui la precede.
      expect(closing?.closureChainHead).toBe(events[events.length - 2].fingerprint);
      expect(closing?.sequence).toBe(events.length);
    });

    it('laisse ouvert un dossier litigieux non resolu', async () => {
      const { reference, aggregator } = await initiate(1250.75);
      await confirm(aggregator, 1.0);

      const report = await verifyChain(reference);

      // La dette n est pas eteinte : rien ne justifie de figer le total.
      expect(report.closed).toBe(false);
      expect(report.declaredEventCount).toBeNull();
    });

    it('ne clot jamais deux fois', async () => {
      const { reference, aggregator } = await initiate();
      await confirm(aggregator, 1250.75);

      const closings = (await chainOf(reference)).filter((e) => e.eventType === 'CASE_CLOSED');
      expect(closings).toHaveLength(1);
    });

    it('DETECTE une troncature de queue une fois le dossier clos', async () => {
      const { reference, aggregator } = await initiate();
      await confirm(aggregator, 1250.75);

      const before = await verifyChain(reference);
      expect(before.verdict).not.toBe('TAMPERED');
      expect(before.closed).toBe(true);

      // Retirer les deux derniers faits laisse une chaine 1..N-2 parfaitement
      // coherente : ni le chainage ni la continuite des rangs ne la refusent.
      // Seul le total declare par la cloture trahit la suppression.
      const events = await chainOf(reference);
      const removed = events.slice(-2).map((e) => e.sequence);
      await withoutAppendOnlyGuard(dataSource, () =>
        dataSource.query(
          'DELETE FROM transaction_events WHERE transaction_reference = $1 AND sequence = ANY($2)',
          [reference, removed],
        ),
      );

      const after = await verifyChain(reference);

      // La cloture a disparu avec la queue : le dossier ne se declare plus clos,
      // ce qui contredit l etat resolu de la transaction.
      expect(after.eventCount).toBe(events.length - 2);
      expect(after.closed).toBe(false);
      expect(after.verdict).toBe('TAMPERED');
    });

    it('DETECTE la suppression d un fait intermediaire malgre la cloture', async () => {
      const { reference, aggregator } = await initiate();
      await confirm(aggregator, 1250.75);

      await withoutAppendOnlyGuard(dataSource, () =>
        dataSource.query(
          'DELETE FROM transaction_events WHERE transaction_reference = $1 AND sequence = 2',
          [reference],
        ),
      );

      const report = await verifyChain(reference);

      expect(report.verdict).toBe('TAMPERED');
      // Deux controles independants la denoncent : le total declare et la
      // continuite des rangs.
      expect(report.declaredEventCount).not.toBe(report.eventCount);
    });
  });

  describe('Verification', () => {
    it('signale une chaine non encore ancree sans crier a l alteration', async () => {
      const { reference, aggregator } = await initiate();
      await confirm(aggregator, 1250.75);

      const report = await verifyChain(reference);

      expect(report.verdict).toBe('PARTIALLY_ANCHORED');
      expect(report.events.every((event) => event.fingerprintMatches)).toBe(true);
    });

    it('retourne EMPTY pour une transaction sans fait consigne', async () => {
      const report = await verifyChain('TRF-20260725-ZZZZZZZZ');
      expect(report.verdict).toBe('EMPTY');
    });

    it('expose le sommet de chaine, resume de tout l historique', async () => {
      const { reference, aggregator } = await initiate();
      await confirm(aggregator, 1250.75);

      const events = await chainOf(reference);
      const report = await verifyChain(reference);

      expect(report.head).toBe(events[events.length - 1].fingerprint);
    });
  });
});
