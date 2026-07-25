import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { anchorConfig, blockchainConfig } from '../config/configuration';
import { SCHEMAS, XsdValidatorService } from '../xml/xsd-validator.service';
import { RECORD_FORMAT_VERSION, TransferXmlBuilder } from '../xml/transfer-xml.builder';
import { Transaction } from '../transactions/entities/transaction.entity';
import { TransactionStatus } from '../transactions/enums/transaction-status.enum';
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
    if (transaction.fingerprint !== null) return transaction;

    try {
      const recordXml = this.xmlBuilder.buildTransferRecord(transaction);
      await this.xsdValidator.assertValid(recordXml, SCHEMAS.transferRecord);

      const salt = generateSalt();
      transaction.fingerprintSalt = salt;
      transaction.fingerprint = computeFingerprint(salt, recordXml);
      transaction.recordFormatVersion = RECORD_FORMAT_VERSION;
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
    try {
      const pending = await this.transactions.find({
        where: { anchorStatus: AnchorStatus.PENDING, fingerprint: Not(IsNull()) },
        order: { sealedAt: 'ASC' },
        take: this.config.batchMaxSize,
      });

      if (pending.length === 0) return { batch: null, anchored: 0, reason: 'NOTHING_TO_ANCHOR' };

      return await this.anchorTransactions(pending);
    } finally {
      this.running = false;
    }
  }

  private async anchorTransactions(pending: Transaction[]): Promise<BatchOutcome> {
    // L'ordre des feuilles fixe l'indice de chaque transaction : il est fige ici
    // et persiste, sinon les preuves deviendraient invalides.
    const leaves = pending.map((transaction) => toLeaf(transaction.fingerprint as string));
    const tree = buildMerkleTree(leaves);

    let batch = await this.batches.save(
      this.batches.create({
        status: BatchStatus.PENDING,
        merkleRoot: tree.root,
        leafCount: pending.length,
        chainId: String(this.chain.chainId),
        contractAddress: this.chain.contractAddress,
        attempts: 0,
      }),
    );

    // Rattachement avant emission : si le processus s'arrete pendant l'ancrage,
    // les transactions ne repartent pas dans un second lot au redemarrage.
    pending.forEach((transaction, index) => {
      transaction.batchId = batch.id;
      transaction.leafIndex = index;
      transaction.merkleProof = getProof(tree, index);
    });
    await this.transactions.save(pending);

    batch.status = BatchStatus.ANCHORING;
    batch.attempts += 1;
    batch = await this.batches.save(batch);

    try {
      const receipt = await this.client.anchorBatch(batch.id, tree.root, pending.length);

      batch.status = BatchStatus.ANCHORED;
      batch.txHash = receipt.txHash;
      batch.blockNumber = receipt.blockNumber;
      batch.gasUsed = receipt.gasUsed;
      batch.anchoredAt = new Date();
      batch.lastError = null;
      batch = await this.batches.save(batch);

      await this.transactions.update(
        { id: In(pending.map((transaction) => transaction.id)) },
        { anchorStatus: AnchorStatus.ANCHORED },
      );

      this.logger.log({
        event: 'anchor.batch.anchored',
        batchId: batch.id,
        merkleRoot: tree.root,
        leafCount: pending.length,
        txHash: receipt.txHash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
      });

      return { batch, anchored: pending.length };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'erreur inconnue';
      const exhausted = batch.attempts >= this.config.maxRetries;

      batch.status = exhausted ? BatchStatus.FAILED : BatchStatus.PENDING;
      batch.lastError = reason.slice(0, 1024);
      batch = await this.batches.save(batch);

      // Reprise : les transactions redeviennent eligibles a un nouveau lot.
      // Abandon definitif : l'empreinte reste exploitable hors chaine.
      await this.transactions.update(
        { id: In(pending.map((transaction) => transaction.id)) },
        exhausted
          ? { anchorStatus: AnchorStatus.FAILED }
          : {
              anchorStatus: AnchorStatus.PENDING,
              batchId: null,
              leafIndex: null,
              merkleProof: null,
            },
      );

      this.logger.error({
        event: exhausted ? 'anchor.batch.abandoned' : 'anchor.batch.retry_scheduled',
        batchId: batch.id,
        attempts: batch.attempts,
        reason,
      });

      return { batch, anchored: 0, reason };
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
