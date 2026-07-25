import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { E2E_AUTHORIZATION } from './setup-e2e';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { AnchorService } from '../src/blockchain/anchor.service';
import { EvmAnchorClient } from '../src/blockchain/evm-anchor.client';
import type { AnchorReceipt, OnChainBatch } from '../src/blockchain/evm-anchor.client';
import { IntegrityVerdict } from '../src/blockchain/enums/anchor-status.enum';
import { toLeaf } from '../src/blockchain/fingerprint.util';
import { processProof, verifyProof } from '../src/blockchain/merkle.util';
import { SoapClientService } from '../src/soap/soap-client.service';
import type { AmountInWordsResult } from '../src/soap/soap.types';

const DEBTOR_IBAN = 'FR7630006000011234567890189';
const CREDITOR_IBAN = 'DE89370400440532013000';

type TestRecord = Record<string, unknown>;
type VerificationBody = TestRecord & { checks: TestRecord };

const asRecord = (value: unknown): TestRecord => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('La reponse de test attendue doit etre un objet.');
  }
  return value as TestRecord;
};

const payload = (overrides: Record<string, unknown> = {}) => ({
  debtorIban: DEBTOR_IBAN,
  debtorName: 'Societe Kongo SARL',
  creditorIban: CREDITOR_IBAN,
  creditorName: 'ACME GmbH',
  amount: 1250.75,
  currency: 'EUR',
  endToEndLabel: 'Facture 2026-0042',
  ...overrides,
});

const soapSuccess = (): AmountInWordsResult => ({
  amountInWords: 'one thousand two hundred and fifty dollars and seventy five cents',
  exchange: {
    operation: 'NumberToDollars',
    endpoint: 'https://example.invalid/NumberConversion.wso',
    rawRequest: '<soap:Envelope><soap:Body><NumberToDollars/></soap:Body></soap:Envelope>',
    rawResponse: '<soap:Envelope><soap:Body><NumberToDollarsResponse/></soap:Body></soap:Envelope>',
    durationMs: 412,
    attempts: 1,
  },
});

/**
 * Registre blockchain en memoire.
 *
 * Reproduit fidelement le contrat `AuditAnchor` : refus de reecriture d'un lot
 * deja ancre, et verification d'inclusion par recalcul de la racine. Les tests
 * restent ainsi hors ligne, sans cesser d'eprouver la logique d'ancrage et de
 * detection d'alteration.
 */
class InMemoryChain {
  readonly batches = new Map<string, OnChainBatch>();
  available = true;
  private block = 0;

  anchorBatch(batchId: string, merkleRoot: string, leafCount: number): AnchorReceipt {
    this.assertAvailable();
    if (this.batches.has(batchId)) throw new Error(`BatchAlreadyAnchored: ${batchId}`);

    this.batches.set(batchId, {
      merkleRoot,
      leafCount,
      anchoredAt: new Date(),
      submitter: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    });
    this.block += 1;

    return {
      txHash: `0x${'ab'.repeat(32)}`,
      blockNumber: String(this.block),
      gasUsed: '121159',
      chainId: '31337',
      contractAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    };
  }

  getBatch(batchId: string): OnChainBatch | null {
    this.assertAvailable();
    return this.batches.get(batchId) ?? null;
  }

  verifyInclusion(batchId: string, leaf: string, proof: readonly string[]): boolean {
    this.assertAvailable();
    const batch = this.batches.get(batchId);
    return batch ? verifyProof(leaf, proof, batch.merkleRoot) : false;
  }

  private assertAvailable(): void {
    if (!this.available) throw new Error('noeud injoignable');
  }
}

describe('Integrite et ancrage blockchain (e2e)', () => {
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
    await dataSource.query(
      'TRUNCATE TABLE transaction_events, audit_logs, transactions, anchor_batches RESTART IDENTITY CASCADE',
    );
  });

  const createTransfer = async (overrides: Record<string, unknown> = {}): Promise<string> => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/transfers')
      .set('Authorization', E2E_AUTHORIZATION)
      .send(payload(overrides))
      .expect(201);
    return response.body.reference as string;
  };

  const verify = async (reference: string): Promise<VerificationBody> => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/transfers/${reference}/verification`)
      .set('Authorization', E2E_AUTHORIZATION)
      .expect(200);
    const body = asRecord(response.body);
    return { ...body, checks: asRecord(body.checks) };
  };

  const rowOf = async (reference: string): Promise<TestRecord> => {
    const rows: unknown = await dataSource.query(
      'SELECT * FROM transactions WHERE reference = $1',
      [reference],
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error(`Transaction de test introuvable : ${reference}`);
    }
    return asRecord(rows[0]);
  };

  // ==========================================================================
  // Scellement
  // ==========================================================================

  describe('Scellement', () => {
    it('scelle la transaction des qu elle atteint un etat terminal', async () => {
      const reference = await createTransfer();
      const row = await rowOf(reference);

      expect(row.fingerprint).toMatch(/^0x[0-9a-f]{64}$/);
      expect(row.fingerprint_salt).toMatch(/^0x[0-9a-f]{64}$/);
      expect(row.anchor_status).toBe('PENDING');
      expect(row.sealed_at).not.toBeNull();
      expect(row.record_format_version).toBe('1.0');
    });

    it('attribue un sel distinct a deux virements identiques', async () => {
      const [first, second] = [
        await rowOf(await createTransfer()),
        await rowOf(await createTransfer()),
      ];

      expect(first.fingerprint_salt).not.toBe(second.fingerprint_salt);
      // Consequence : deux virements identiques n exposent pas la meme empreinte.
      expect(first.fingerprint).not.toBe(second.fingerprint);
    });

    it('scelle egalement une transaction en echec', async () => {
      convertAmountToWords.mockRejectedValue(new Error('panne du back-office'));

      const failure = await request(app.getHttpServer())
        .post('/api/v1/transfers')
        .set('Authorization', E2E_AUTHORIZATION)
        .send(payload())
        .expect(500);

      const row = await rowOf(failure.body.reference as string);
      expect(row.status).toBe('FAILED');
      expect(row.fingerprint).toMatch(/^0x[0-9a-f]{64}$/);
    });
  });

  // ==========================================================================
  // Validation XSD
  // ==========================================================================

  describe('Validation XSD', () => {
    it('consigne le document canonique valide dans la piste d audit', async () => {
      const reference = await createTransfer();

      const audit = await request(app.getHttpServer())
        .get(`/api/v1/transfers/${reference}/audit`)
        .set('Authorization', E2E_AUTHORIZATION)
        .expect(200);

      const entries: unknown = audit.body;
      const document = Array.isArray(entries)
        ? entries.map(asRecord).find((entry) => entry.direction === 'DOCUMENT_VALIDATED')
        : undefined;

      expect(document).toBeDefined();
      expect(document?.operation).toBe('transfer-request.xsd');
      expect(document?.payload).toContain('<TransferRequest');
      // Le document consigne reste masque : pas d IBAN complet.
      expect(document?.payload).not.toContain(DEBTOR_IBAN);
    });
  });

  // ==========================================================================
  // Ancrage
  // ==========================================================================

  describe('Ancrage par lots', () => {
    it('regroupe plusieurs transactions sous une seule racine de Merkle', async () => {
      const references = [
        await createTransfer({ amount: 10.01 }),
        await createTransfer({ amount: 20.02 }),
        await createTransfer({ amount: 30.03 }),
      ];

      const outcome = await request(app.getHttpServer())
        .post('/api/v1/anchors/batches')
        .set('Authorization', E2E_AUTHORIZATION)
        .expect(200);

      // Le lot couvre desormais les transactions ET les faits du registre : le
      // compte total depasse donc 3, mais une seule ecriture on-chain a lieu.
      const [{ count }] = await dataSource.query(
        'SELECT COUNT(*)::int AS count FROM transaction_events',
      );
      expect(outcome.body.anchored).toBe(3 + count);
      expect(chain.batches.size).toBe(1);

      for (const reference of references) {
        const row = await rowOf(reference);
        expect(row.anchor_status).toBe('ANCHORED');
        expect(row.batch_id).toBe(outcome.body.batchId);
        expect(row.merkle_proof).toBeInstanceOf(Array);
      }
    });

    it('produit une preuve d inclusion valide pour chaque transaction du lot', async () => {
      const references = await Promise.all(
        Array.from({ length: 5 }, (_, index) => createTransfer({ amount: 100 + index })),
      );
      await anchorService.processPendingBatch();

      for (const reference of references) {
        const row = await rowOf(reference);
        const onChain = chain.getBatch(row.batch_id as string);

        expect(processProof(toLeaf(row.fingerprint as string), row.merkle_proof as string[])).toBe(
          onChain?.merkleRoot,
        );
      }
    });

    it('n ancre rien quand la file est vide', async () => {
      const outcome = await request(app.getHttpServer())
        .post('/api/v1/anchors/batches')
        .set('Authorization', E2E_AUTHORIZATION)
        .expect(200);

      expect(outcome.body).toMatchObject({ anchored: 0, reason: 'NOTHING_TO_ANCHOR' });
    });

    it('expose le lot et sa transaction blockchain', async () => {
      await createTransfer();
      const outcome = await request(app.getHttpServer())
        .post('/api/v1/anchors/batches')
        .set('Authorization', E2E_AUTHORIZATION)
        .expect(200);

      const batch = await request(app.getHttpServer())
        .get(`/api/v1/anchors/batches/${outcome.body.batchId}`)
        .set('Authorization', E2E_AUTHORIZATION)
        .expect(200);

      expect(batch.body).toMatchObject({
        status: 'ANCHORED',
        leafCount: 1,
        chainId: '31337',
      });
      expect(batch.body.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('remet les transactions en file quand la chaine est injoignable', async () => {
      const reference = await createTransfer();
      chain.available = false;

      const outcome = await request(app.getHttpServer())
        .post('/api/v1/anchors/batches')
        .set('Authorization', E2E_AUTHORIZATION)
        .expect(200);
      expect(outcome.body.anchored).toBe(0);

      const retried = await rowOf(reference);
      // Le rattachement au lot reste stable : une reprise ne peut pas publier
      // une seconde preuve sous un nouvel identifiant.
      expect(retried.anchor_status).toBe('PENDING');
      expect(retried.batch_id).toBe(outcome.body.batchId);

      chain.available = true;
      const recovery = await request(app.getHttpServer())
        .post('/api/v1/anchors/batches')
        .set('Authorization', E2E_AUTHORIZATION)
        .expect(200);
      expect(recovery.body.anchored).toBe(1);
      expect(recovery.body.batchId).toBe(outcome.body.batchId);

      const batches: unknown = await dataSource.query(
        'SELECT id, attempts FROM anchor_batches ORDER BY created_at',
      );
      expect(batches).toEqual([{ id: outcome.body.batchId, attempts: 2 }]);
    });

    it('abandonne le meme lot apres epuisement du budget de reprises', async () => {
      const reference = await createTransfer();
      chain.available = false;

      const batchIds: unknown[] = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const outcome = await request(app.getHttpServer())
          .post('/api/v1/anchors/batches')
          .set('Authorization', E2E_AUTHORIZATION)
          .expect(200);
        batchIds.push(outcome.body.batchId as unknown);
      }

      expect(new Set(batchIds).size).toBe(1);
      const row = await rowOf(reference);
      expect(row.anchor_status).toBe('FAILED');

      const batches: unknown = await dataSource.query(
        'SELECT status, attempts FROM anchor_batches',
      );
      expect(batches).toEqual([{ status: 'FAILED', attempts: 3 }]);

      chain.available = true;
      const afterExhaustion = await request(app.getHttpServer())
        .post('/api/v1/anchors/batches')
        .set('Authorization', E2E_AUTHORIZATION)
        .expect(200);
      expect(afterExhaustion.body).toMatchObject({
        anchored: 0,
        reason: 'NOTHING_TO_ANCHOR',
      });
    });

    it('reprend un lot deja mine sans publier une seconde transaction', async () => {
      const reference = await createTransfer();
      const first = await anchorService.processPendingBatch();
      expect(first.anchored).toBe(1);
      expect(chain.batches.size).toBe(1);

      // Simule un arret apres minage mais avant la transaction SQL finale.
      await dataSource.query(`UPDATE anchor_batches SET status = 'ANCHORING' WHERE id = $1`, [
        first.batch?.id,
      ]);
      await dataSource.query(
        `UPDATE transactions SET anchor_status = 'PENDING' WHERE reference = $1`,
        [reference],
      );

      const recovered = await anchorService.processPendingBatch();

      expect(recovered).toMatchObject({ anchored: 1 });
      expect(recovered.batch?.id).toBe(first.batch?.id);
      expect(chain.batches.size).toBe(1);
      expect((await rowOf(reference)).anchor_status).toBe('ANCHORED');
    });
  });

  // ==========================================================================
  // Verification d'integrite
  // ==========================================================================

  describe('Verification d integrite', () => {
    it('confirme une transaction intacte et ancree', async () => {
      const reference = await createTransfer();
      await anchorService.processPendingBatch();

      const body = await verify(reference);

      expect(body.verdict).toBe(IntegrityVerdict.VERIFIED);
      expect(body.checks).toMatchObject({
        recordRebuilt: true,
        xsdValid: true,
        fingerprintMatches: true,
        merkleProofValid: true,
        onChainRootMatches: true,
        onChainInclusionVerified: true,
      });
      expect(body.sealedFingerprint).toBe(body.recomputedFingerprint);
    });

    it('signale une transaction scellee mais pas encore ancree', async () => {
      const body = await verify(await createTransfer());

      expect(body.verdict).toBe(IntegrityVerdict.PENDING_ANCHOR);
      expect(body.checks.fingerprintMatches).toBe(true);
    });

    it.each([
      ['IBAN du beneficiaire', 'creditor_iban', 'GB82WEST12345698765432'],
      ['nom du beneficiaire', 'creditor_name', 'Societe Ecran SARL'],
      ['montant', 'amount', '9999.99'],
      ['devise', 'currency', 'USD'],
      ['libelle', 'end_to_end_label', 'Autre motif'],
    ])('detecte la modification du %s', async (_champ, colonne, valeur) => {
      const reference = await createTransfer();
      await anchorService.processPendingBatch();

      await dataSource.query(`UPDATE transactions SET ${colonne} = $1 WHERE reference = $2`, [
        valeur,
        reference,
      ]);

      const body = await verify(reference);

      expect(body.verdict).toBe(IntegrityVerdict.TAMPERED);
      expect(body.checks.fingerprintMatches).toBe(false);
      expect(body.sealedFingerprint).not.toBe(body.recomputedFingerprint);
    });

    it('detecte une falsification meme si l attaquant recalcule l empreinte', async () => {
      const reference = await createTransfer();
      await anchorService.processPendingBatch();

      // L attaquant modifie la donnee ET realigne l empreinte stockee.
      await dataSource.query('UPDATE transactions SET creditor_iban = $1 WHERE reference = $2', [
        'GB82WEST12345698765432',
        reference,
      ]);
      const forged = (await verify(reference)).recomputedFingerprint as string;
      await dataSource.query('UPDATE transactions SET fingerprint = $1 WHERE reference = $2', [
        forged,
        reference,
      ]);

      const body = await verify(reference);

      // L empreinte concorde de nouveau, mais la preuve ne mene plus a la racine.
      expect(body.checks.fingerprintMatches).toBe(true);
      expect(body.checks.merkleProofValid).toBe(false);
      expect(body.verdict).toBe(IntegrityVerdict.TAMPERED);
    });

    it('detecte une falsification meme si l attaquant forge aussi la racine en base', async () => {
      const reference = await createTransfer();
      await anchorService.processPendingBatch();

      await dataSource.query('UPDATE transactions SET creditor_iban = $1 WHERE reference = $2', [
        'GB82WEST12345698765432',
        reference,
      ]);
      const forged = (await verify(reference)).recomputedFingerprint as string;
      await dataSource.query('UPDATE transactions SET fingerprint = $1 WHERE reference = $2', [
        forged,
        reference,
      ]);

      // Il recalcule la racine coherente avec la feuille falsifiee et l ecrit en base.
      const row = await rowOf(reference);
      const forgedRoot = processProof(toLeaf(forged), row.merkle_proof as string[]);
      await dataSource.query('UPDATE anchor_batches SET merkle_root = $1 WHERE id = $2', [
        forgedRoot,
        row.batch_id,
      ]);

      const body = await verify(reference);

      // Tous les controles internes passent : seule la chaine tranche.
      expect(body.checks.fingerprintMatches).toBe(true);
      expect(body.checks.merkleProofValid).toBe(true);
      expect(body.checks.onChainRootMatches).toBe(false);
      expect(body.verdict).toBe(IntegrityVerdict.TAMPERED);
    });

    it('detecte une preuve d inclusion alteree', async () => {
      const reference = await createTransfer();
      await anchorService.processPendingBatch();

      await dataSource.query('UPDATE transactions SET merkle_proof = $1 WHERE reference = $2', [
        JSON.stringify([`0x${'11'.repeat(32)}`]),
        reference,
      ]);

      const body = await verify(reference);
      expect(body.verdict).toBe(IntegrityVerdict.TAMPERED);
      expect(body.checks.merkleProofValid).toBe(false);
    });

    it('signale un lot marque ancre en base mais absent de la chaine', async () => {
      const reference = await createTransfer();
      await anchorService.processPendingBatch();

      chain.batches.clear(); // la preuve n existe plus sur le registre independant

      const body = await verify(reference);
      expect(body.verdict).toBe(IntegrityVerdict.TAMPERED);
    });

    it('distingue une chaine injoignable d une alteration', async () => {
      const reference = await createTransfer();
      await anchorService.processPendingBatch();
      chain.available = false;

      const body = await verify(reference);

      expect(body.verdict).toBe(IntegrityVerdict.CHAIN_UNAVAILABLE);
      // Les controles hors chaine restent concluants : ce n est pas une alteration.
      expect(body.checks.fingerprintMatches).toBe(true);
      expect(body.checks.merkleProofValid).toBe(true);
    });

    it('classe un sel de scellement malforme comme une alteration', async () => {
      const reference = await createTransfer();
      await dataSource.query('UPDATE transactions SET fingerprint_salt = $1 WHERE reference = $2', [
        'sel-invalide',
        reference,
      ]);

      const body = await verify(reference);

      expect(body.verdict).toBe(IntegrityVerdict.TAMPERED);
      expect(body.checks.fingerprintMatches).toBe(false);
      expect(body.findings).toEqual(
        expect.arrayContaining([expect.stringContaining('donnees de scellement sont invalides')]),
      );
    });

    it('retourne 404 pour une reference inconnue', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/transfers/TRF-20260725-ZZZZZZZZ/verification')
        .set('Authorization', E2E_AUTHORIZATION)
        .expect(404);
    });
  });

  // ==========================================================================
  // Supervision
  // ==========================================================================

  describe('Supervision', () => {
    it('rapporte l etat des schemas XSD et de la blockchain', async () => {
      const { body } = await request(app.getHttpServer())
        .get('/api/v1/health')
        .set('Authorization', E2E_AUTHORIZATION)
        .expect(200);

      expect(body.components.xsdSchemas.status).toBe('up');
      expect(body.components.blockchain).toMatchObject({ status: 'up', enabled: true });
    });

    it('expose la repartition par etat d ancrage', async () => {
      await createTransfer();
      await anchorService.processPendingBatch();
      await createTransfer();

      const { body } = await request(app.getHttpServer())
        .get('/api/v1/anchors/statistics')
        .set('Authorization', E2E_AUTHORIZATION)
        .expect(200);

      expect(body).toMatchObject({ ANCHORED: 1, PENDING: 1 });
    });
  });
});
