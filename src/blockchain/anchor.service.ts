import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, QueryRunner, Repository } from 'typeorm';
import { anchorConfig, blockchainConfig } from '../config/configuration';
import { SCHEMAS, XsdValidatorService } from '../xml/xsd-validator.service';
import { TransferXmlBuilder } from '../xml/transfer-xml.builder';
import { Transaction } from '../transactions/entities/transaction.entity';
import { TransactionStatus } from '../transactions/enums/transaction-status.enum';
import { PaymentChannel, ReconciliationStatus } from '../mobile-money/enums/mobile-money.enum';
import { AnchorBatch } from './entities/anchor-batch.entity';
import { AnchorStatus, BatchStatus } from './enums/anchor-status.enum';
import { EvmAnchorClient } from './evm-anchor.client';
import { computeFingerprint, generateSalt, toLeaf } from './fingerprint.util';
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

interface ClaimedBatch {
  batch: AnchorBatch;
  transactions: Transaction[];
}

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
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly xmlBuilder: TransferXmlBuilder,
    private readonly xsdValidator: XsdValidatorService,
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
        detail: 'BLOCKCHAIN_ENABLED=false — les transactions sont scellees mais jamais ancrees',
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

  /**
   * Scelle une transaction parvenue a un etat terminal.
   *
   * Produit le document XML canonique, le valide contre `transfer-record.xsd`,
   * puis calcule l'empreinte salee. Le document lui-meme n'est pas conserve : il
   * est reconstructible a l'identique depuis la base, et c'est precisement cette
   * reconstruction qui permet de detecter une alteration.
   *
   * N'echoue jamais le virement : un defaut de scellement est journalise et la
   * transaction reste `NOT_SEALED`.
   */
  async sealTransaction(transaction: Transaction): Promise<Transaction> {
    if (
      transaction.status !== TransactionStatus.COMPLETED &&
      transaction.status !== TransactionStatus.FAILED
    ) {
      return transaction;
    }
    if (
      transaction.paymentChannel === PaymentChannel.MOBILE_MONEY &&
      transaction.reconciliationStatus !== ReconciliationStatus.MATCHED
    ) {
      return transaction;
    }
    if (transaction.fingerprint !== null) return transaction;

    try {
      const recordXml = this.xmlBuilder.buildTransferRecord(transaction);
      await this.xsdValidator.assertValid(recordXml, SCHEMAS.transferRecord);

      const salt = generateSalt();
      transaction.fingerprintSalt = salt;
      transaction.fingerprint = computeFingerprint(salt, recordXml);
      transaction.recordFormatVersion = this.xmlBuilder.getRecordFormatVersion(transaction);
      transaction.sealedAt = new Date();
      transaction.anchorStatus = AnchorStatus.PENDING;

      const sealed = await this.transactions.save(transaction);

      this.logger.log({
        event: 'transaction.sealed',
        reference: sealed.reference,
        fingerprint: sealed.fingerprint,
      });

      return sealed;
    } catch (error) {
      this.logger.error({
        event: 'transaction.seal.failed',
        reference: transaction.reference,
        reason: error instanceof Error ? error.message : 'erreur inconnue',
      });
      return transaction;
    }
  }

  // -------------------------------------------------------------------------
  // Ancrage
  // -------------------------------------------------------------------------

  /**
   * Constitue un lot avec les transactions scellees en attente, publie sa racine
   * sur la chaine, puis persiste la preuve d'inclusion de chaque transaction.
   *
   * Protege contre les executions concurrentes : le declencheur periodique et un
   * appel manuel ne doivent pas ancrer deux fois les memes transactions.
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

      return await this.anchorTransactions(claimed.batch, claimed.transactions);
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
      const batches = manager.getRepository(AnchorBatch);
      const pending = await transactions
        .createQueryBuilder('transaction')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .where('transaction.anchorStatus = :status', { status: AnchorStatus.PENDING })
        .andWhere('transaction.fingerprint IS NOT NULL')
        .andWhere(
          '(transaction.paymentChannel != :mobileMoney OR transaction.reconciliationStatus = :matched)',
          {
            mobileMoney: PaymentChannel.MOBILE_MONEY,
            matched: ReconciliationStatus.MATCHED,
          },
        )
        .andWhere('transaction.batchId IS NULL')
        .orderBy('transaction.sealedAt', 'ASC')
        .take(this.config.batchMaxSize)
        .getMany();

      if (pending.length === 0) return null;

      const leaves = pending.map((transaction) => toLeaf(transaction.fingerprint as string));
      const tree = buildMerkleTree(leaves);
      const batch = await batches.save(
        batches.create({
          status: BatchStatus.PENDING,
          merkleRoot: tree.root,
          leafCount: pending.length,
          chainId: String(this.chain.chainId),
          contractAddress: this.chain.contractAddress,
          attempts: 0,
        }),
      );

      pending.forEach((transaction, index) => {
        transaction.batchId = batch.id;
        transaction.leafIndex = index;
        transaction.merkleProof = getProof(tree, index);
      });
      await transactions.save(pending);

      return { batch, transactions: pending };
    });
  }

  /** Retrouve un lot laisse PENDING/ANCHORING par un arret du processus. */
  private async findResumableBatch(): Promise<ClaimedBatch | null> {
    const candidates = await this.batches.find({
      where: { status: In([BatchStatus.PENDING, BatchStatus.ANCHORING]) },
      order: { createdAt: 'ASC' },
    });

    for (const batch of candidates) {
      const transactions = await this.transactions.find({
        where: { batchId: batch.id },
        order: { leafIndex: 'ASC' },
      });

      if (transactions.length === batch.leafCount && transactions.length > 0) {
        return { batch, transactions };
      }

      batch.status = BatchStatus.FAILED;
      batch.lastError = `Lot incomplet apres reprise : ${transactions.length}/${batch.leafCount} transactions`;
      await this.batches.save(batch);
      if (transactions.length > 0) {
        await this.transactions.update(
          { id: In(transactions.map((transaction) => transaction.id)) },
          { anchorStatus: AnchorStatus.FAILED },
        );
      }
    }

    return null;
  }

  private async anchorTransactions(
    batch: AnchorBatch,
    pending: Transaction[],
  ): Promise<BatchOutcome> {
    const leaves = pending.map((transaction) => toLeaf(transaction.fingerprint as string));
    const tree = buildMerkleTree(leaves);

    if (tree.root.toLowerCase() !== batch.merkleRoot.toLowerCase()) {
      return this.recordBatchFailure(
        batch,
        pending,
        'Les empreintes du lot ne correspondent plus a sa racine de Merkle',
        true,
      );
    }

    // Apres epuisement du budget, une derniere lecture permet de recuperer une
    // transaction deja minee avant un arret, sans emettre une nouvelle ecriture.
    if (batch.attempts >= this.config.maxRetries) {
      try {
        const onChain = await this.client.getBatch(batch.id);
        if (onChain) return this.finalizeRecoveredBatch(batch, pending, onChain);
      } catch {
        // Le budget est deja epuise : l'indisponibilite est consignée ci-dessous.
      }
      return this.recordBatchFailure(
        batch,
        pending,
        `Nombre maximal de tentatives atteint (${this.config.maxRetries})`,
        true,
      );
    }

    batch.status = BatchStatus.ANCHORING;
    batch.attempts += 1;
    batch = await this.batches.save(batch);

    try {
      const existing = await this.client.getBatch(batch.id);
      if (existing) return this.finalizeRecoveredBatch(batch, pending, existing);

      const receipt = await this.client.anchorBatch(batch.id, tree.root, pending.length);
      return this.finalizeBatch(batch, pending, {
        txHash: receipt.txHash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
        chainId: receipt.chainId,
        contractAddress: receipt.contractAddress,
        anchoredAt: new Date(),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'erreur inconnue';
      return this.recordBatchFailure(batch, pending, reason);
    }
  }

  private async finalizeRecoveredBatch(
    batch: AnchorBatch,
    pending: Transaction[],
    onChain: {
      merkleRoot: string;
      leafCount: number;
      anchoredAt: Date;
    },
  ): Promise<BatchOutcome> {
    if (
      onChain.merkleRoot.toLowerCase() !== batch.merkleRoot.toLowerCase() ||
      onChain.leafCount !== batch.leafCount
    ) {
      return this.recordBatchFailure(
        batch,
        pending,
        'Le lot existant sur la chaine ne correspond pas au lot persiste',
        true,
      );
    }

    return this.finalizeBatch(batch, pending, {
      anchoredAt: onChain.anchoredAt,
    });
  }

  /** Rend atomiques le statut du lot et celui de toutes ses transactions. */
  private async finalizeBatch(
    batch: AnchorBatch,
    pending: Transaction[],
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
      const batches = manager.getRepository(AnchorBatch);
      const transactions = manager.getRepository(Transaction);

      batch.status = BatchStatus.ANCHORED;
      batch.txHash = chainData.txHash ?? batch.txHash;
      batch.blockNumber = chainData.blockNumber ?? batch.blockNumber;
      batch.gasUsed = chainData.gasUsed ?? batch.gasUsed;
      batch.chainId = chainData.chainId ?? batch.chainId;
      batch.contractAddress = chainData.contractAddress ?? batch.contractAddress;
      batch.anchoredAt = chainData.anchoredAt;
      batch.lastError = null;
      const anchored = await batches.save(batch);

      await transactions.update(
        { id: In(pending.map((transaction) => transaction.id)) },
        { anchorStatus: AnchorStatus.ANCHORED },
      );
      return anchored;
    });

    this.logger.log({
      event: 'anchor.batch.anchored',
      batchId: saved.id,
      merkleRoot: saved.merkleRoot,
      leafCount: saved.leafCount,
      txHash: saved.txHash,
      blockNumber: saved.blockNumber,
      gasUsed: saved.gasUsed,
    });

    return { batch: saved, anchored: pending.length };
  }

  private async recordBatchFailure(
    batch: AnchorBatch,
    pending: Transaction[],
    reason: string,
    forceFailure = false,
  ): Promise<BatchOutcome> {
    const exhausted = forceFailure || batch.attempts >= this.config.maxRetries;
    const saved = await this.dataSource.transaction(async (manager) => {
      const batches = manager.getRepository(AnchorBatch);
      const transactions = manager.getRepository(Transaction);

      batch.status = exhausted ? BatchStatus.FAILED : BatchStatus.PENDING;
      batch.lastError = reason.slice(0, 1024);
      const failed = await batches.save(batch);

      if (exhausted) {
        await transactions.update(
          { id: In(pending.map((transaction) => transaction.id)) },
          { anchorStatus: AnchorStatus.FAILED },
        );
      }
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

  /** Repartition des transactions par etat d'ancrage. */
  async getStatistics(): Promise<Record<string, number>> {
    const rows = await this.transactions
      .createQueryBuilder('t')
      .select('t.anchor_status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('t.anchor_status')
      .getRawMany<{ status: string; count: string }>();

    return Object.fromEntries(rows.map((row) => [row.status, Number.parseInt(row.count, 10)]));
  }
}
