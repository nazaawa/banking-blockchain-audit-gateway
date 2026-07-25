import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AnchorService } from '../src/blockchain/anchor.service';
import { EvmAnchorClient } from '../src/blockchain/evm-anchor.client';
import type { AnchorReceipt, OnChainBatch } from '../src/blockchain/evm-anchor.client';
import { verifyProof } from '../src/blockchain/merkle.util';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { SoapClientService } from '../src/soap/soap-client.service';
import type { AmountInWordsResult } from '../src/soap/soap.types';
import { TransactionEvent } from '../src/events/entities/transaction-event.entity';
import { FieldCipher } from '../src/security/field-cipher';
import { E2E_AUTHORIZATION } from './setup-e2e';

const DEBTOR_IBAN = 'FR7630006000011234567890189';
const CREDITOR_IBAN = 'DE89370400440532013000';

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
    endpoint: 'https://example.test/soap',
    rawRequest: '<r/>',
    rawResponse: '<r/>',
    durationMs: 412,
    attempts: 1,
  },
});

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
      txHash: `0x${'ab'.repeat(32)}`,
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

/**
 * Detection d'alteration des donnees de paiement.
 *
 * Ces scenarios eprouvaient le scellement d'instantane, que le registre
 * append-only remplace desormais. La preuve porte sur la suite des faits, et
 * l'evenement d'ouverture consigne les parties du virement.
 *
 * C'est le controle croise entre la ligne `transactions` et cet enregistrement
 * qui rend le remplacement equivalent : sans lui, modifier un IBAN beneficiaire
 * apres coup serait redevenu indetectable.
 */
describe('Integrite des donnees de paiement (e2e)', () => {
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
      'TRUNCATE TABLE refunds, transaction_events, mobile_money_webhook_events, audit_logs, ' +
        'transactions, anchor_batches RESTART IDENTITY CASCADE',
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

  const verify = async (reference: string): Promise<Record<string, any>> =>
    (
      await request(app.getHttpServer())
        .get(`/api/v1/transfers/${reference}/verification`)
        .set('Authorization', E2E_AUTHORIZATION)
        .expect(200)
    ).body as Record<string, any>;

  // ==========================================================================

  describe('Consignation des parties', () => {
    it('inscrit les parties du virement des l ouverture', async () => {
      const reference = await createTransfer();

      const [opening] = await dataSource.query<Array<Record<string, string>>>(
        'SELECT event_type, record_format_version, encryption_version, ' +
          'debtor_iban, creditor_iban, creditor_name ' +
          'FROM transaction_events WHERE transaction_reference = $1 ORDER BY sequence LIMIT 1',
        [reference],
      );

      expect(opening.event_type).toBe('TRANSFER_INITIATED');
      expect(opening.record_format_version).toBe('2.1');
      expect(Number(opening.encryption_version)).toBe(1);

      // Lecture SQL brute : la base ne contient que du chiffre. C'est la seule
      // maniere de le prouver — l'entite dechiffre de maniere transparente, donc
      // toute lecture applicative montrerait le clair meme sans chiffrement.
      expect(opening.debtor_iban).toMatch(/^enc\.v1\./);
      expect(opening.creditor_iban).toMatch(/^enc\.v1\./);
      expect(opening.creditor_name).toMatch(/^enc\.v1\./);
      expect(opening.creditor_iban).not.toContain(CREDITOR_IBAN);

      const [storedTransaction] = await dataSource.query<Array<Record<string, string>>>(
        'SELECT encryption_version, debtor_iban, creditor_iban, creditor_name ' +
          'FROM transactions WHERE reference = $1',
        [reference],
      );
      expect(Number(storedTransaction.encryption_version)).toBe(1);
      expect(storedTransaction.debtor_iban).toMatch(/^enc\.v1\./);
      expect(storedTransaction.creditor_iban).toMatch(/^enc\.v1\./);
      expect(storedTransaction.creditor_name).toMatch(/^enc\.v1\./);
      expect(storedTransaction.creditor_iban).not.toContain(CREDITOR_IBAN);

      // Et le clair reste accessible a l'application, sans quoi la verification
      // d'integrite ne pourrait plus confronter la ligne au registre.
      const decrypted = await dataSource
        .getRepository(TransactionEvent)
        .findOneByOrFail({ transactionReference: reference, sequence: 1 });

      expect(decrypted.debtorIban).toBe(DEBTOR_IBAN);
      expect(decrypted.creditorIban).toBe(CREDITOR_IBAN);
      expect(decrypted.creditorName).toBe('ACME GmbH');
    });

    it('REFUSE un retour SQL vers une valeur en clair', async () => {
      const reference = await createTransfer();

      await expect(
        dataSource.query(
          `UPDATE transactions
           SET creditor_iban = $1, encryption_version = 0
           WHERE reference = $2`,
          ['DE89370400440532013000', reference],
        ),
      ).rejects.toThrow(/CHK_transactions_(creditor_iban_encrypted|encryption_version)/);

      const [stored] = await dataSource.query<Array<{ creditor_iban: string }>>(
        'SELECT creditor_iban FROM transactions WHERE reference = $1',
        [reference],
      );
      expect(stored.creditor_iban).toMatch(/^enc\.v1\./);
    });

    it('conserve les empreintes verifiables malgre le chiffrement', async () => {
      const reference = await createTransfer();
      await anchorService.processPendingBatch();

      // Le document canonique est construit depuis le clair : le chiffrement
      // vit sous l'entite. Si ce n'etait pas le cas, toutes les preuves deja
      // publiees sur la chaine deviendraient invérifiables d'un seul coup.
      const report = await verify(reference);

      expect(report.verdict).toBe('VERIFIED');
      expect(
        report.events.every((event: { fingerprintMatches: boolean }) => event.fingerprintMatches),
      ).toBe(true);
    });

    it('ne les repete pas sur les faits suivants', async () => {
      const reference = await createTransfer();

      const rows = await dataSource.query<Array<{ creditor_iban: string | null }>>(
        'SELECT creditor_iban FROM transaction_events WHERE transaction_reference = $1 ' +
          'ORDER BY sequence OFFSET 1',
        [reference],
      );

      // Les repeter alourdirait la chaine sans rien prouver de plus.
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.creditor_iban === null)).toBe(true);
    });

    it('ne les restitue jamais en clair sur la surface HTTP', async () => {
      const reference = await createTransfer();

      const { text, body } = await request(app.getHttpServer())
        .get(`/api/v1/transfers/${reference}/events`)
        .set('Authorization', E2E_AUTHORIZATION)
        .expect(200);

      // Le registre les consigne en clair — c'est la reference de la
      // verification — mais la regle du masquage vaut ici comme ailleurs.
      expect(text).not.toContain(DEBTOR_IBAN);
      expect(text).not.toContain(CREDITOR_IBAN);
      expect((body as Array<Record<string, unknown>>)[0]).toMatchObject({
        debtorIbanMasked: 'FR76****0189',
        creditorIbanMasked: 'DE89****3000',
      });
    });
  });

  // ==========================================================================

  describe('Detection d alteration', () => {
    it('confirme un virement intact', async () => {
      const reference = await createTransfer();
      await anchorService.processPendingBatch();

      const report = await verify(reference);

      expect(report.verdict).toBe('VERIFIED');
      expect(report.transactionMatchesLedger).toBe(true);
    });

    it.each([
      ['IBAN du beneficiaire', 'creditor_iban', 'GB82WEST12345698765432'],
      ['nom du beneficiaire', 'creditor_name', 'Societe Ecran SARL'],
      ['IBAN du donneur d ordre', 'debtor_iban', 'BE68539007547034'],
      ['montant', 'amount', '9999.99'],
      ['devise', 'currency', 'USD'],
      ['libelle', 'end_to_end_label', 'Autre motif'],
    ])('DETECTE la modification du %s', async (_champ, colonne, valeur) => {
      const reference = await createTransfer();
      await anchorService.processPendingBatch();

      const storedValue = ['creditor_iban', 'creditor_name', 'debtor_iban'].includes(colonne)
        ? FieldCipher.encrypt(valeur, `transactions.${colonne}`)
        : valeur;
      await dataSource.query(`UPDATE transactions SET ${colonne} = $1 WHERE reference = $2`, [
        storedValue,
        reference,
      ]);

      const report = await verify(reference);

      expect(report.verdict).toBe('TAMPERED');
      expect(report.transactionMatchesLedger).toBe(false);
    });

    it('nomme le champ altere pour orienter l enquete', async () => {
      const reference = await createTransfer();
      await dataSource.query('UPDATE transactions SET creditor_iban = $1 WHERE reference = $2', [
        FieldCipher.encrypt('GB82WEST12345698765432', 'transactions.creditor_iban'),
        reference,
      ]);

      expect((await verify(reference)).findings.join(' ')).toContain('IBAN du beneficiaire');
    });

    it('resiste a un attaquant qui altererait aussi le fait consigne', async () => {
      const reference = await createTransfer();
      await anchorService.processPendingBatch();

      await dataSource.query('UPDATE transactions SET creditor_iban = $1 WHERE reference = $2', [
        FieldCipher.encrypt('GB82WEST12345698765432', 'transactions.creditor_iban'),
        reference,
      ]);

      // Reconcilier l evenement d ouverture avec la ligne falsifiee supposerait
      // de modifier un fait consigne : la base elle-meme le refuse.
      await expect(
        dataSource.query(
          'UPDATE transaction_events SET creditor_iban = $1 WHERE transaction_reference = $2',
          [
            FieldCipher.encrypt('GB82WEST12345698765432', 'transaction_events.creditor_iban'),
            reference,
          ],
        ),
      ).rejects.toThrow(/append-only/);

      expect((await verify(reference)).verdict).toBe('TAMPERED');
    });

    it('detecte la suppression de la cloture d un virement classique', async () => {
      const reference = await createTransfer();

      await dataSource.query(
        'ALTER TABLE transaction_events DISABLE TRIGGER trg_transaction_events_append_only',
      );
      try {
        await dataSource.query(
          `DELETE FROM transaction_events
           WHERE transaction_reference = $1 AND event_type = 'CASE_CLOSED'`,
          [reference],
        );
      } finally {
        await dataSource.query(
          'ALTER TABLE transaction_events ENABLE TRIGGER trg_transaction_events_append_only',
        );
      }

      const report = await verify(reference);
      expect(report.verdict).toBe('TAMPERED');
      expect(report.findings.join(' ')).toContain('cloture est absent');
    });
  });

  // ==========================================================================

  describe('Ancrage', () => {
    it('ancre la seule cloture et confirme qu elle engage tous les faits', async () => {
      const reference = await createTransfer();

      const outcome = await anchorService.processPendingBatch();
      expect(outcome.anchored).toBeGreaterThan(0);
      expect(chain.batches.size).toBe(1);

      const report = await verify(reference);
      expect(report.verdict).toBe('VERIFIED');
      expect(report.finalProofAnchored).toBe(true);
      expect(report.anchoredCount).toBe(1);
    });

    it('n ancre rien quand la file est vide', async () => {
      const outcome = await anchorService.processPendingBatch();
      expect(outcome.anchored).toBe(0);
    });

    it('reprend le meme lot de cloture apres une indisponibilite', async () => {
      const reference = await createTransfer();
      chain.available = false;

      const first = await anchorService.processPendingBatch();
      expect(first.anchored).toBe(0);
      expect(first.batch?.id).toBeDefined();

      chain.available = true;
      const recovered = await anchorService.processPendingBatch();

      expect(recovered).toMatchObject({ anchored: 1 });
      expect(recovered.batch?.id).toBe(first.batch?.id);
      expect(chain.batches.size).toBe(1);
      expect((await verify(reference)).verdict).toBe('VERIFIED');
    });

    it('detecte une preuve d inclusion de cloture alteree', async () => {
      const reference = await createTransfer();
      await anchorService.processPendingBatch();

      await dataSource.query(
        `UPDATE transaction_events
         SET merkle_proof = $1
         WHERE transaction_reference = $2 AND event_type = 'CASE_CLOSED'`,
        [JSON.stringify([`0x${'11'.repeat(32)}`]), reference],
      );

      expect((await verify(reference)).verdict).toBe('TAMPERED');
    });

    it('detecte un lot marque ancre mais absent de la chaine', async () => {
      const reference = await createTransfer();
      await anchorService.processPendingBatch();
      chain.batches.clear();

      expect((await verify(reference)).verdict).toBe('TAMPERED');
    });

    it('distingue une chaine injoignable d une alteration', async () => {
      const reference = await createTransfer();
      await anchorService.processPendingBatch();
      chain.available = false;

      const report = await verify(reference);

      expect(report.verdict).toBe('CHAIN_UNAVAILABLE');
      expect(report.transactionMatchesLedger).toBe(true);
    });
  });

  // ==========================================================================

  describe('Supervision', () => {
    it('rapporte l etat des schemas XSD et de la blockchain', async () => {
      const { body } = await request(app.getHttpServer()).get('/api/v1/health').expect(200);

      expect(body.components.xsdSchemas.status).toBe('up');
      expect(body.components.blockchain).toMatchObject({ status: 'up', enabled: true });
    });
  });
});
