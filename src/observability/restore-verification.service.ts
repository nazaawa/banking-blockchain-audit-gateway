import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AnchorBatch } from '../blockchain/entities/anchor-batch.entity';
import { BatchStatus } from '../blockchain/enums/anchor-status.enum';
import { EvmAnchorClient } from '../blockchain/evm-anchor.client';
import { TransactionEvent } from '../events/entities/transaction-event.entity';

export interface BatchAudit {
  batchId: string;
  anchoredAt: Date | null;
  /** Nombre de feuilles declare on-chain au moment de la publication. */
  publishedLeafCount: number | null;
  /** Nombre de faits effectivement presents en base pour ce lot. */
  restoredLeafCount: number;
  missing: number;
  verdict: 'COMPLETE' | 'INCOMPLETE' | 'ABSENT_ON_CHAIN' | 'CHAIN_UNAVAILABLE';
}

export interface RestoreReport {
  verdict: 'CONSISTENT' | 'DATA_LOSS' | 'CHAIN_UNAVAILABLE';
  batchesExamined: number;
  eventsMissing: number;
  batches: BatchAudit[];
  findings: string[];
  verifiedAt: Date;
}

/**
 * Controle de coherence apres restauration.
 *
 * ## Pourquoi cet outil existe
 *
 * Sur ce systeme, une sauvegarde ne suffit pas a restaurer. Un instantane
 * anterieur au dernier ancrage produit une base ou manquent des faits **deja
 * publies sur la chaine**. La verification d'integrite rendra `TAMPERED` — et
 * elle aura raison : des preuves opposables porteront sur des donnees absentes.
 *
 * Sans cet outil, l'exploitant constate des verdicts `TAMPERED` en cascade sans
 * savoir s'il fait face a une attaque ou a une restauration trop ancienne. Les
 * deux appellent des reactions opposees : l'une declenche une enquete, l'autre
 * un rejeu des journaux.
 *
 * ## Ce qu'il compare
 *
 * Pour chaque lot marque ancre en base, il relit le nombre de feuilles
 * **publie** sur la chaine et le confronte au nombre de faits reellement
 * presents. La chaine, que l'operateur ne controle pas, sert ici de temoin de ce
 * qui existait au moment de la publication.
 */
@Injectable()
export class RestoreVerificationService {
  private readonly logger = new Logger(RestoreVerificationService.name);

  constructor(
    @InjectRepository(AnchorBatch)
    private readonly batches: Repository<AnchorBatch>,
    @InjectRepository(TransactionEvent)
    private readonly events: Repository<TransactionEvent>,
    private readonly client: EvmAnchorClient,
  ) {}

  async verify(): Promise<RestoreReport> {
    const anchored = await this.batches.find({
      where: { status: BatchStatus.ANCHORED },
      order: { anchoredAt: 'ASC' },
    });

    const audits: BatchAudit[] = [];
    const findings: string[] = [];
    let chainUnavailable = false;
    let eventsMissing = 0;

    for (const batch of anchored) {
      const restoredLeafCount = await this.events.countBy({ batchId: batch.id });
      const audit = await this.auditBatch(batch, restoredLeafCount);

      audits.push(audit);
      if (audit.verdict === 'CHAIN_UNAVAILABLE') chainUnavailable = true;
      if (audit.missing > 0) eventsMissing += audit.missing;
    }

    if (eventsMissing > 0) {
      findings.push(
        `${eventsMissing} fait(s) publie(s) sur la chaine sont absents de la base. ` +
          'La sauvegarde restauree est anterieure a ces ancrages : rejouez les journaux ' +
          'de transaction jusqu au dernier lot publie avant de remettre le service en ligne.',
      );
      findings.push(
        'Ne pas confondre avec une alteration : les faits ne sont pas modifies, ils manquent. ' +
          'Une attaque laisserait des empreintes qui ne correspondent plus, pas des lots incomplets.',
      );
    } else if (chainUnavailable) {
      findings.push(
        'Chaine injoignable : la completude n a pas pu etre etablie. ' +
          'Ne remettez pas le service en ligne sur la foi de ce rapport.',
      );
    } else {
      findings.push(
        `Les ${anchored.length} lot(s) ancre(s) sont complets : la base contient tout ce ` +
          'qui a ete publie. La restauration peut etre consideree comme fidele.',
      );
    }

    const verdict: RestoreReport['verdict'] =
      eventsMissing > 0 ? 'DATA_LOSS' : chainUnavailable ? 'CHAIN_UNAVAILABLE' : 'CONSISTENT';

    this.logger.log({
      event: 'restore.verified',
      verdict,
      batchesExamined: anchored.length,
      eventsMissing,
    });

    return {
      verdict,
      batchesExamined: anchored.length,
      eventsMissing,
      batches: audits,
      findings,
      verifiedAt: new Date(),
    };
  }

  private async auditBatch(batch: AnchorBatch, restoredLeafCount: number): Promise<BatchAudit> {
    const base = {
      batchId: batch.id,
      anchoredAt: batch.anchoredAt,
      restoredLeafCount,
    };

    try {
      const onChain = await this.client.getBatch(batch.id);

      if (!onChain) {
        // Le lot est marque ancre en base mais introuvable sur la chaine : c'est
        // l'inverse d'une perte de donnees, et cela merite son propre verdict.
        return {
          ...base,
          publishedLeafCount: null,
          missing: 0,
          verdict: 'ABSENT_ON_CHAIN',
        };
      }

      const published = Number(onChain.leafCount);
      return {
        ...base,
        publishedLeafCount: published,
        missing: Math.max(0, published - restoredLeafCount),
        verdict: published === restoredLeafCount ? 'COMPLETE' : 'INCOMPLETE',
      };
    } catch (error) {
      this.logger.warn({
        event: 'restore.chain.unavailable',
        batchId: batch.id,
        reason: error instanceof Error ? error.message : 'erreur inconnue',
      });
      return { ...base, publishedLeafCount: null, missing: 0, verdict: 'CHAIN_UNAVAILABLE' };
    }
  }
}
