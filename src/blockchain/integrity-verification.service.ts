import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SCHEMAS, XsdValidatorService } from '../xml/xsd-validator.service';
import { TransferXmlBuilder } from '../xml/transfer-xml.builder';
import type { Transaction } from '../transactions/entities/transaction.entity';
import { AnchorBatch } from './entities/anchor-batch.entity';
import { AnchorStatus, IntegrityVerdict } from './enums/anchor-status.enum';
import { EvmAnchorClient } from './evm-anchor.client';
import { computeFingerprint, toLeaf } from './fingerprint.util';
import { verifyProof } from './merkle.util';

/** Detail des controles effectues. `null` = controle non applicable ou non atteint. */
export interface IntegrityChecks {
  /** Le document canonique a pu etre reconstruit depuis la base. */
  recordRebuilt: boolean;
  /** Le document reconstruit reste conforme a son XSD. */
  xsdValid: boolean | null;
  /** L'empreinte recalculee correspond a l'empreinte scellee. */
  fingerprintMatches: boolean | null;
  /** La preuve d'inclusion mene bien a la racine du lot (verification hors chaine). */
  merkleProofValid: boolean | null;
  /** La racine enregistree en base correspond a celle publiee sur la chaine. */
  onChainRootMatches: boolean | null;
  /** Le contrat confirme lui-meme l'inclusion de la transaction dans le lot. */
  onChainInclusionVerified: boolean | null;
}

export interface IntegrityReport {
  reference: string;
  verdict: IntegrityVerdict;
  checks: IntegrityChecks;
  sealedFingerprint: string | null;
  recomputedFingerprint: string | null;
  recordFormatVersion: string | null;
  batch: {
    id: string;
    merkleRoot: string;
    leafIndex: number | null;
    txHash: string | null;
    blockNumber: string | null;
    chainId: string | null;
    contractAddress: string | null;
    anchoredAt: Date | null;
  } | null;
  onChain: {
    merkleRoot: string;
    leafCount: number;
    anchoredAt: Date;
    submitter: string;
  } | null;
  findings: string[];
  verifiedAt: Date;
}

/**
 * Controle d'integrite a posteriori d'une transaction.
 *
 * ## Principe
 *
 * Le document scelle n'est pas stocke : il est **reconstruit** a partir des
 * colonnes de la base, puis rehache avec le sel d'origine. Si une seule valeur a
 * change — un IBAN beneficiaire, un montant, un centime — l'empreinte recalculee
 * differe de l'empreinte scellee, et l'alteration est detectee.
 *
 * ## Pourquoi la blockchain est indispensable ici
 *
 * Comparer l'empreinte recalculee a une empreinte stockee dans la meme base ne
 * prouve rien : qui modifie une ligne peut modifier l'empreinte. La chaine
 * apporte le point de reference que l'operateur ne controle plus — la racine de
 * Merkle y est immuable. Falsifier une transaction supposerait de modifier la
 * ligne, son empreinte, la racine du lot **et** l'historique de la chaine.
 */
@Injectable()
export class IntegrityVerificationService {
  private readonly logger = new Logger(IntegrityVerificationService.name);

  constructor(
    @InjectRepository(AnchorBatch)
    private readonly batches: Repository<AnchorBatch>,
    private readonly xmlBuilder: TransferXmlBuilder,
    private readonly xsdValidator: XsdValidatorService,
    private readonly client: EvmAnchorClient,
  ) {}

  async verify(transaction: Transaction): Promise<IntegrityReport> {
    const findings: string[] = [];
    const checks: IntegrityChecks = {
      recordRebuilt: false,
      xsdValid: null,
      fingerprintMatches: null,
      merkleProofValid: null,
      onChainRootMatches: null,
      onChainInclusionVerified: null,
    };

    const report = (
      verdict: IntegrityVerdict,
      extra: Partial<IntegrityReport> = {},
    ): IntegrityReport => ({
      reference: transaction.reference,
      verdict,
      checks,
      sealedFingerprint: transaction.fingerprint,
      recomputedFingerprint: null,
      recordFormatVersion: transaction.recordFormatVersion,
      batch: null,
      onChain: null,
      findings,
      verifiedAt: new Date(),
      ...extra,
    });

    // ---- 1. La transaction a-t-elle ete scellee ? -------------------------
    if (!transaction.fingerprint || !transaction.fingerprintSalt) {
      findings.push(
        "Transaction jamais scellee : aucune empreinte n'a ete calculee, aucune preuve n'existe.",
      );
      return report(IntegrityVerdict.NOT_SEALED);
    }

    // ---- 2. Reconstruction du document canonique --------------------------
    let recordXml: string;
    try {
      recordXml = this.xmlBuilder.buildTransferRecord(transaction);
      checks.recordRebuilt = true;
    } catch (error) {
      findings.push(
        `Reconstruction du document impossible : ${error instanceof Error ? error.message : 'erreur inconnue'}`,
      );
      return report(IntegrityVerdict.TAMPERED);
    }

    const violations = await this.xsdValidator.validate(recordXml, SCHEMAS.transferRecord);
    checks.xsdValid = violations.length === 0;
    if (!checks.xsdValid) {
      findings.push(
        `Le document reconstruit ne respecte plus son schema : ${violations
          .map((violation) => violation.message)
          .join(' | ')}`,
      );
    }

    // ---- 3. Comparaison des empreintes ------------------------------------
    const recomputed = computeFingerprint(transaction.fingerprintSalt, recordXml);
    checks.fingerprintMatches = recomputed.toLowerCase() === transaction.fingerprint.toLowerCase();

    if (!checks.fingerprintMatches) {
      findings.push(
        'ALTERATION DETECTEE : les donnees en base ne produisent plus l empreinte scellee. ' +
          'Au moins un champ couvert par la preuve a ete modifie apres le scellement.',
      );
      return report(IntegrityVerdict.TAMPERED, { recomputedFingerprint: recomputed });
    }

    findings.push('Les donnees en base correspondent exactement a l empreinte scellee.');

    // ---- 4. La preuve est-elle ancree ? -----------------------------------
    if (
      transaction.anchorStatus !== AnchorStatus.ANCHORED ||
      !transaction.batchId ||
      !transaction.merkleProof
    ) {
      findings.push(
        `Ancrage non acquis (statut ${transaction.anchorStatus}) : l integrite est confirmee ` +
          'localement, mais sans point de reference independant de cette base.',
      );
      return report(IntegrityVerdict.PENDING_ANCHOR, { recomputedFingerprint: recomputed });
    }

    const batch = await this.batches.findOne({ where: { id: transaction.batchId } });
    if (!batch) {
      findings.push(`Lot ${transaction.batchId} introuvable en base : preuve inexploitable.`);
      return report(IntegrityVerdict.TAMPERED, { recomputedFingerprint: recomputed });
    }

    const batchInfo = {
      id: batch.id,
      merkleRoot: batch.merkleRoot,
      leafIndex: transaction.leafIndex,
      txHash: batch.txHash,
      blockNumber: batch.blockNumber,
      chainId: batch.chainId,
      contractAddress: batch.contractAddress,
      anchoredAt: batch.anchoredAt,
    };

    // ---- 5. Preuve d'inclusion, hors chaine -------------------------------
    const leaf = toLeaf(transaction.fingerprint);
    checks.merkleProofValid = verifyProof(leaf, transaction.merkleProof, batch.merkleRoot);

    if (!checks.merkleProofValid) {
      findings.push(
        'La preuve d inclusion ne mene pas a la racine du lot : preuve ou racine alteree en base.',
      );
      return report(IntegrityVerdict.TAMPERED, {
        recomputedFingerprint: recomputed,
        batch: batchInfo,
      });
    }

    // ---- 6. Confrontation a la chaine -------------------------------------
    try {
      const onChain = await this.client.getBatch(batch.id);

      if (!onChain) {
        findings.push(
          `Le lot ${batch.id} est marque ancre en base mais absent de la chaine : ` +
            'la preuve ne repose sur aucun enregistrement independant.',
        );
        return report(IntegrityVerdict.TAMPERED, {
          recomputedFingerprint: recomputed,
          batch: batchInfo,
        });
      }

      checks.onChainRootMatches =
        onChain.merkleRoot.toLowerCase() === batch.merkleRoot.toLowerCase();

      if (!checks.onChainRootMatches) {
        findings.push(
          `ALTERATION DETECTEE : la racine en base (${batch.merkleRoot}) differe de celle ` +
            `publiee sur la chaine (${onChain.merkleRoot}).`,
        );
        return report(IntegrityVerdict.TAMPERED, {
          recomputedFingerprint: recomputed,
          batch: batchInfo,
          onChain,
        });
      }

      // Verification par le contrat lui-meme : ne depend d'aucun code de la passerelle.
      checks.onChainInclusionVerified = await this.client.verifyInclusion(
        batch.id,
        leaf,
        transaction.merkleProof,
      );

      if (!checks.onChainInclusionVerified) {
        findings.push('Le contrat refuse la preuve d inclusion de cette transaction.');
        return report(IntegrityVerdict.TAMPERED, {
          recomputedFingerprint: recomputed,
          batch: batchInfo,
          onChain,
        });
      }

      findings.push(
        `Inclusion confirmee par le contrat ${batch.contractAddress} (chaine ${batch.chainId}), ` +
          `racine publiee dans la transaction ${batch.txHash}.`,
      );

      return report(IntegrityVerdict.VERIFIED, {
        recomputedFingerprint: recomputed,
        batch: batchInfo,
        onChain,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'erreur inconnue';
      this.logger.warn({
        event: 'integrity.chain.unavailable',
        reference: transaction.reference,
        reason,
      });

      findings.push(
        `Chaine injoignable (${reason}) : les controles hors chaine sont concluants, ` +
          'mais la confrontation au registre independant n a pas pu etre faite.',
      );

      return report(IntegrityVerdict.CHAIN_UNAVAILABLE, {
        recomputedFingerprint: recomputed,
        batch: batchInfo,
      });
    }
  }
}
