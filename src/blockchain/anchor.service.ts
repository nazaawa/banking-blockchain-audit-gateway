import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, QueryRunner, Repository } from 'typeorm';
import { anchorConfig, blockchainConfig } from '../config/configuration';
import { Transaction } from '../transactions/entities/transaction.entity';
import { TransactionEvent } from '../events/entities/transaction-event.entity';
import { TransactionEventType } from '../events/enums/transaction-event.enum';
import { AnchorBatch } from './entities/anchor-batch.entity';
import { AnchorStatus, BatchStatus } from './enums/anchor-status.enum';
import { EvmAnchorClient } from './evm-anchor.client';
import { toLeaf } from './fingerprint.util';
import { buildMerkleTree, getProof } from './merkle.util';

/** Resultat de la constitution et de l'ancrage d'un lot. */
export interface BatchOutcome {
  batch: AnchorBatch | null;
  anchored: number;
  reason?: string;
}

const ANCHOR_JOB = 'anchor-pending-transactions';

/** Verrou PostgreSQL partage par toutes les instances de la passerelle. */
const ANCHOR_ADVISORY_LOCK_ID = 1_111_577_675;

/**
 * Elements couverts par un lot.
 *
 * Un lot porte indifferemment des instantanes de transaction et des faits du
 * registre : le cout d'ancrage etant constant, les separer en deux lots
 * doublerait la depense sans rien prouver de plus.
 */
interface BatchItems {
  transactions: Transaction[];
  events: TransactionEvent[];
}

interface ClaimedBatch {
  batch: AnchorBatch;
  items: BatchItems;
}

/** Tout element ancrable expose ces champs, quelle que soit sa table. */
interface AnchorableItem {
  id: string;
  fingerprint: string | null;
  leafIndex: number | null;
}

const countItems = (items: BatchItems): number => items.transactions.length + items.events.length;

/**
 * Scellement des transactions et ancrage par lots sur la blockchain.
 *
 * ## Pourquoi l'ancrage est asynchrone
 *
 * Une inscription sur une chaine prend de quelques secondes a plusieurs minutes.
 * L'inclure dans le cycle HTTP du virement reproduirait exactement le defaut que
 * l'on evite deja sur l'appel SOAP : faire dependre la reponse au client d'un
 * systeme externe lent. Le scellement (calcul de l'empreinte) est synchrone et
 * immediat ; l'ancrage est differe et repris en cas d'echec.
 *
 * ## Pourquoi par lots
 *
 * Ancrer chaque virement individuellement ferait croitre le cout lineairement.
 * En publiant la racine de Merkle d'un lot, le cout est constant — un seul mot
 * de 32 octets — quel que soit le nombre de transactions, et chaque virement
 * reste prouvable individuellement par sa preuve d'inclusion.
 */
@Injectable()
export class AnchorService implements OnModuleInit {
  private readonly logger = new Logger(AnchorService.name);
  private running = false;

  constructor(
    @InjectRepository(Transaction)
    private readonly transactions: Repository<Transaction>,
    @InjectRepository(AnchorBatch)
    private readonly batches: Repository<AnchorBatch>,
    @InjectRepository(TransactionEvent)
    private readonly events: Repository<TransactionEvent>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly client: EvmAnchorClient,
    private readonly scheduler: SchedulerRegistry,
    @Inject(blockchainConfig.KEY)
    private readonly chain: ConfigType<typeof blockchainConfig>,
    @Inject(anchorConfig.KEY)
    private readonly config: ConfigType<typeof anchorConfig>,
  ) {}

  onModuleInit(): void {
    if (!this.chain.enabled) {
      this.logger.warn({
        event: 'anchor.disabled',
        detail: 'BLOCKCHAIN_ENABLED=false — les faits sont scelles mais jamais ancres',
      });
      return;
    }

    const interval = setInterval(() => {
      void this.processPendingBatch().catch((error: unknown) => {
        this.logger.error({
          event: 'anchor.job.failed',
          reason: error instanceof Error ? error.message : 'erreur inconnue',
        });
      });
    }, this.config.intervalMs);

    this.scheduler.addInterval(ANCHOR_JOB, interval);
    this.logger.log({ event: 'anchor.scheduler.started', intervalMs: this.config.intervalMs });
  }

  // -------------------------------------------------------------------------
  // Scellement
  // -------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Ancrage
  //
  // Le scellement d'instantane a ete retire : le registre append-only le
  // remplace. Une preuve d'etat courant ne disait que « voici a quoi la ligne
  // ressemble » ; la chaine de faits prouve ce qui s'est produit, et son controle
  // confronte en plus la ligne a ce que l'ouverture a consigne.
  // ---------------------------------------------------------------------------
  // -------------------------------------------------------------------------

  /**
   * Constitue un lot avec les clotures en attente, publie sa racine sur la
   * chaine, puis persiste leur preuve d'inclusion.
   *
   * Protege contre les executions concurrentes : le declencheur periodique et un
   * appel manuel ne doivent pas ancrer deux fois les memes clotures.
   */
  async processPendingBatch(): Promise<BatchOutcome> {
    if (!this.chain.enabled) return { batch: null, anchored: 0, reason: 'ANCHORING_DISABLED' };
    if (this.running) return { batch: null, anchored: 0, reason: 'ALREADY_RUNNING' };

    this.running = true;
    let lock: QueryRunner | null = null;
    try {
      lock = await this.acquireDistributedLock();
      if (!lock) return { batch: null, anchored: 0, reason: 'ALREADY_RUNNING' };

      const claimed = await this.findOrCreateBatch();
      if (!claimed) return { batch: null, anchored: 0, reason: 'NOTHING_TO_ANCHOR' };

      return await this.anchorBatchItems(claimed.batch, claimed.items);
    } finally {
      try {
        if (lock) await this.releaseDistributedLock(lock);
      } finally {
        this.running = false;
      }
    }
  }

  /**
   * Recupere d'abord un lot interrompu, puis constitue un nouveau lot si besoin.
   *
   * La constitution est transactionnelle et verrouille les lignes avec
   * `SKIP LOCKED` : meme sans le verrou consultatif, deux travailleurs ne
   * peuvent pas rattacher la meme transaction a deux lots.
   */
  private async findOrCreateBatch(): Promise<ClaimedBatch | null> {
    const resumable = await this.findResumableBatch();
    if (resumable) return resumable;

    return this.dataSource.transaction(async (manager) => {
      const transactions = manager.getRepository(Transaction);
      const events = manager.getRepository(TransactionEvent);
      const batches = manager.getRepository(AnchorBatch);

      // Le scellement d'instantane ayant ete retire, plus aucune transaction
      // n'entre en file : le lot ne couvre desormais que les faits du registre.
      // La structure reste generique, les lots anterieurs contenant encore des
      // transactions devant pouvoir etre repris a l'identique.
      const pendingTransactions: Transaction[] = [];

      const pendingEvents = await events
        .createQueryBuilder('event')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .where('event.anchorStatus = :status', { status: AnchorStatus.PENDING })
        // La cloture engage recursivement tout l'historique via son
        // previousFingerprint. Ancrer les faits intermediaires dupliquerait les
        // preuves et publierait un etat encore susceptible d'evoluer.
        .andWhere('event.eventType = :eventType', {
          eventType: TransactionEventType.CASE_CLOSED,
        })
        .andWhere('event.batchId IS NULL')
        .orderBy('event.createdAt', 'ASC')
        .take(this.config.batchMaxSize)
        .getMany();

      const items: BatchItems = { transactions: pendingTransactions, events: pendingEvents };
      const total = countItems(items);
      if (total === 0) return null;

      // L'ordre des feuilles fixe les indices : transactions puis evenements.
      // Il est fige ici et persiste, sinon les preuves deviendraient invalides.
      const ordered: AnchorableItem[] = [...pendingTransactions, ...pendingEvents];
      const tree = buildMerkleTree(ordered.map((item) => toLeaf(item.fingerprint as string)));

      const batch = await batches.save(
        batches.create({
          status: BatchStatus.PENDING,
          merkleRoot: tree.root,
          leafCount: total,
          chainId: String(this.chain.chainId),
          contractAddress: this.chain.contractAddress,
          attempts: 0,
        }),
      );

      ordered.forEach((item, index) => {
        Object.assign(item, {
          batchId: batch.id,
          leafIndex: index,
          merkleProof: getProof(tree, index),
        });
      });

      if (pendingTransactions.length > 0) await transactions.save(pendingTransactions);
      if (pendingEvents.length > 0) await events.save(pendingEvents);

      return { batch, items };
    });
  }

  /** Retrouve un lot laisse PENDING/ANCHORING par un arret du processus. */
  private async findResumableBatch(): Promise<ClaimedBatch | null> {
    const candidates = await this.batches.find({
      where: { status: In([BatchStatus.PENDING, BatchStatus.ANCHORING]) },
      order: { createdAt: 'ASC' },
    });

    for (const batch of candidates) {
      const items: BatchItems = {
        transactions: await this.transactions.find({
          where: { batchId: batch.id },
          order: { leafIndex: 'ASC' },
        }),
        events: await this.events.find({
          where: { batchId: batch.id },
          order: { leafIndex: 'ASC' },
        }),
      };

      const total = countItems(items);
      if (total === batch.leafCount && total > 0) return { batch, items };

      batch.status = BatchStatus.FAILED;
      batch.lastError = `Lot incomplet apres reprise : ${total}/${batch.leafCount} elements`;
      await this.batches.save(batch);
      if (total > 0) await this.markItems(items, AnchorStatus.FAILED);
    }

    return null;
  }

  /**
   * Reconstitue les feuilles a partir des indices persistes.
   *
   * Reconstruire par ordre d'insertion serait fragile : la reprise relit deux
   * tables separement, et rien ne garantit que leur concatenation redonne
   * l'ordre d'origine. L'indice est la seule source fiable.
   */
  private orderedLeaves(items: BatchItems, leafCount: number): string[] {
    const leaves = new Array<string | undefined>(leafCount);

    for (const item of [...items.transactions, ...items.events] as AnchorableItem[]) {
      const index = item.leafIndex;
      if (index === null || index < 0 || index >= leafCount) {
        throw new Error(`Indice de feuille invalide (${index}) pour l'element ${item.id}`);
      }
      if (item.fingerprint === null) {
        throw new Error(`Element ${item.id} sans empreinte dans un lot`);
      }
      leaves[index] = toLeaf(item.fingerprint);
    }

    const missing = leaves.findIndex((leaf) => leaf === undefined);
    if (missing !== -1) throw new Error(`Feuille manquante a l'indice ${missing}`);

    return leaves as string[];
  }

  /** Applique un statut d'ancrage aux deux natures d'elements. */
  private async markItems(
    items: BatchItems,
    status: AnchorStatus,
    manager?: { getRepository: typeof this.transactions.manager.getRepository },
  ): Promise<void> {
    const transactions = manager ? manager.getRepository(Transaction) : this.transactions;
    const events = manager ? manager.getRepository(TransactionEvent) : this.events;

    if (items.transactions.length > 0) {
      await transactions.update(
        { id: In(items.transactions.map((item) => item.id)) },
        { anchorStatus: status },
      );
    }
    if (items.events.length > 0) {
      await events.update(
        { id: In(items.events.map((item) => item.id)) },
        { anchorStatus: status },
      );

      // `transactions.anchor_status` reste la source de l'indicateur public
      // historique `anchored`. Il ne porte plus la preuve elle-meme : on y
      // projette seulement le statut de la cloture, sans batch ni chemin Merkle.
      const closedReferences = items.events
        .filter((event) => event.eventType === TransactionEventType.CASE_CLOSED)
        .map((event) => event.transactionReference);
      if (closedReferences.length > 0) {
        await transactions.update({ reference: In(closedReferences) }, { anchorStatus: status });
      }
    }
  }

  private async anchorBatchItems(batch: AnchorBatch, items: BatchItems): Promise<BatchOutcome> {
    const total = countItems(items);

    let leaves: string[];
    try {
      leaves = this.orderedLeaves(items, batch.leafCount);
    } catch (error) {
      return this.recordBatchFailure(
        batch,
        items,
        error instanceof Error ? error.message : 'Lot incoherent',
        true,
      );
    }

    const tree = buildMerkleTree(leaves);
    if (tree.root.toLowerCase() !== batch.merkleRoot.toLowerCase()) {
      return this.recordBatchFailure(
        batch,
        items,
        'Les empreintes du lot ne correspondent plus a sa racine de Merkle',
        true,
      );
    }

    // Apres epuisement du budget, une derniere lecture permet de recuperer un
    // lot deja mine avant un arret, sans emettre une nouvelle ecriture.
    if (batch.attempts >= this.config.maxRetries) {
      try {
        const onChain = await this.client.getBatch(batch.id);
        if (onChain) return this.finalizeRecoveredBatch(batch, items, onChain);
      } catch {
        // Le budget est deja epuise : l'indisponibilite est consignee ci-dessous.
      }
      return this.recordBatchFailure(
        batch,
        items,
        `Nombre maximal de tentatives atteint (${this.config.maxRetries})`,
        true,
      );
    }

    batch.status = BatchStatus.ANCHORING;
    batch.attempts += 1;
    batch = await this.batches.save(batch);

    try {
      const existing = await this.client.getBatch(batch.id);
      if (existing) return this.finalizeRecoveredBatch(batch, items, existing);

      const receipt = await this.client.anchorBatch(batch.id, tree.root, total);
      return this.finalizeBatch(batch, items, {
        txHash: receipt.txHash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
        chainId: receipt.chainId,
        contractAddress: receipt.contractAddress,
        anchoredAt: new Date(),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'erreur inconnue';
      return this.recordBatchFailure(batch, items, reason);
    }
  }

  private async finalizeRecoveredBatch(
    batch: AnchorBatch,
    items: BatchItems,
    onChain: { merkleRoot: string; leafCount: number; anchoredAt: Date },
  ): Promise<BatchOutcome> {
    if (
      onChain.merkleRoot.toLowerCase() !== batch.merkleRoot.toLowerCase() ||
      onChain.leafCount !== batch.leafCount
    ) {
      return this.recordBatchFailure(
        batch,
        items,
        'Le lot existant sur la chaine ne correspond pas au lot persiste',
        true,
      );
    }

    return this.finalizeBatch(batch, items, { anchoredAt: onChain.anchoredAt });
  }

  /** Rend atomiques le statut du lot et celui de tous ses elements. */
  private async finalizeBatch(
    batch: AnchorBatch,
    items: BatchItems,
    chainData: {
      txHash?: string;
      blockNumber?: string;
      gasUsed?: string;
      chainId?: string;
      contractAddress?: string;
      anchoredAt: Date;
    },
  ): Promise<BatchOutcome> {
    const saved = await this.dataSource.transaction(async (manager) => {
      batch.status = BatchStatus.ANCHORED;
      batch.txHash = chainData.txHash ?? batch.txHash;
      batch.blockNumber = chainData.blockNumber ?? batch.blockNumber;
      batch.gasUsed = chainData.gasUsed ?? batch.gasUsed;
      batch.chainId = chainData.chainId ?? batch.chainId;
      batch.contractAddress = chainData.contractAddress ?? batch.contractAddress;
      batch.anchoredAt = chainData.anchoredAt;
      batch.lastError = null;
      const anchored = await manager.getRepository(AnchorBatch).save(batch);

      await this.markItems(items, AnchorStatus.ANCHORED, manager);
      return anchored;
    });

    this.logger.log({
      event: 'anchor.batch.anchored',
      batchId: saved.id,
      merkleRoot: saved.merkleRoot,
      leafCount: saved.leafCount,
      transactions: items.transactions.length,
      events: items.events.length,
      txHash: saved.txHash,
      blockNumber: saved.blockNumber,
      gasUsed: saved.gasUsed,
    });

    return { batch: saved, anchored: countItems(items) };
  }

  private async recordBatchFailure(
    batch: AnchorBatch,
    items: BatchItems,
    reason: string,
    forceFailure = false,
  ): Promise<BatchOutcome> {
    const exhausted = forceFailure || batch.attempts >= this.config.maxRetries;
    const saved = await this.dataSource.transaction(async (manager) => {
      batch.status = exhausted ? BatchStatus.FAILED : BatchStatus.PENDING;
      batch.lastError = reason.slice(0, 1024);
      const failed = await manager.getRepository(AnchorBatch).save(batch);

      if (exhausted) await this.markItems(items, AnchorStatus.FAILED, manager);
      return failed;
    });

    this.logger.error({
      event: exhausted ? 'anchor.batch.abandoned' : 'anchor.batch.retry_scheduled',
      batchId: saved.id,
      attempts: saved.attempts,
      reason,
    });

    return { batch: saved, anchored: 0, reason };
  }

  /** Verrou session PostgreSQL : couvre aussi les appels RPC hors transaction. */
  private async acquireDistributedLock(): Promise<QueryRunner | null> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();

    try {
      const rows = (await runner.query('SELECT pg_try_advisory_lock($1) AS acquired', [
        ANCHOR_ADVISORY_LOCK_ID,
      ])) as Array<{ acquired: boolean }>;

      if (rows[0]?.acquired) return runner;
      await runner.release();
      return null;
    } catch (error) {
      await runner.release();
      throw error;
    }
  }

  private async releaseDistributedLock(runner: QueryRunner): Promise<void> {
    try {
      await runner.query('SELECT pg_advisory_unlock($1)', [ANCHOR_ADVISORY_LOCK_ID]);
    } finally {
      await runner.release();
    }
  }

  // -------------------------------------------------------------------------
  // Consultation
  // -------------------------------------------------------------------------

  async findBatch(id: string): Promise<AnchorBatch | null> {
    return this.batches.findOne({ where: { id } });
  }

  async listBatches(limit = 20): Promise<AnchorBatch[]> {
    return this.batches.find({ order: { createdAt: 'DESC' }, take: limit });
  }

  /** Repartition des evenements du registre par etat d'ancrage. */
  async getEventStatistics(): Promise<Record<string, number>> {
    const rows = await this.events
      .createQueryBuilder('e')
      .select('e.anchor_status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('e.anchor_status')
      .getRawMany<{ status: string; count: string }>();

    return Object.fromEntries(rows.map((row) => [row.status, Number.parseInt(row.count, 10)]));
  }

  /**
   * Repartition des dossiers par etat de leur preuve finale.
   *
   * Les nouvelles operations prennent le statut de leur evenement CASE_CLOSED.
   * Les archives anterieures a la migration conservent celui de l'instantane de
   * transaction, afin que la supervision ne perde pas leur preuve historique.
   */
  async getStatistics(): Promise<Record<string, number>> {
    const rows = await this.transactions
      .createQueryBuilder('t')
      .leftJoin(
        TransactionEvent,
        'closure',
        'closure.transaction_reference = t.reference AND closure.event_type = :eventType',
        { eventType: TransactionEventType.CASE_CLOSED },
      )
      .select('COALESCE(closure.anchor_status::text, t.anchor_status::text)', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('COALESCE(closure.anchor_status::text, t.anchor_status::text)')
      .getRawMany<{ status: string; count: string }>();

    return Object.fromEntries(rows.map((row) => [row.status, Number.parseInt(row.count, 10)]));
  }
}
