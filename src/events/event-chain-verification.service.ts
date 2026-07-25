import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AnchorBatch } from '../blockchain/entities/anchor-batch.entity';
import { AnchorStatus } from '../blockchain/enums/anchor-status.enum';
import { EvmAnchorClient } from '../blockchain/evm-anchor.client';
import { computeFingerprint, toLeaf } from '../blockchain/fingerprint.util';
import { verifyProof } from '../blockchain/merkle.util';
import { SCHEMAS, XsdValidatorService } from '../xml/xsd-validator.service';
import type { TransactionEvent } from './entities/transaction-event.entity';
import { TransactionEventType } from './enums/transaction-event.enum';
import { TransactionEventsService } from './transaction-events.service';
import { Transaction } from '../transactions/entities/transaction.entity';
import {
  PaymentChannel,
  ProviderStatus,
  ReconciliationStatus,
  RefundStatus,
} from '../mobile-money/enums/mobile-money.enum';
import { TransactionStatus } from '../transactions/enums/transaction-status.enum';

/** Verdict porte sur un maillon de la chaine. */
export interface EventVerification {
  sequence: number;
  eventType: string;
  occurredAt: Date;
  /** Le document reconstruit reste conforme a son XSD. */
  xsdValid: boolean;
  /** L'empreinte recalculee correspond a l'empreinte scellee. */
  fingerprintMatches: boolean;
  /** Le maillon pointe bien vers l'empreinte du fait precedent. */
  chainIntact: boolean;
  /** La preuve d'inclusion mene a la racine publiee sur la chaine. */
  anchorVerified: boolean | null;
  findings: string[];
}

export interface EventChainReport {
  transactionReference: string;
  verdict: 'VERIFIED' | 'TAMPERED' | 'PARTIALLY_ANCHORED' | 'EMPTY' | 'CHAIN_UNAVAILABLE';
  /** Le dossier porte-t-il une preuve de synthese ? */
  closed: boolean;
  /** La preuve de synthese finale est-elle confirmee sur la chaine ? */
  finalProofAnchored: boolean;
  /**
   * La ligne `transactions` correspond-elle encore a ce que l'ouverture a
   * consigne ? `null` si aucune ouverture ne porte les parties.
   */
  transactionMatchesLedger: boolean | null;
  /** Nombre de faits declare par la cloture, s'il y en a une. */
  declaredEventCount: number | null;
  eventCount: number;
  anchoredCount: number;
  /** Empreinte du dernier maillon : resume l'ensemble de la chaine. */
  head: string | null;
  events: EventVerification[];
  findings: string[];
  verifiedAt: Date;
}

/**
 * Controle d'integrite du registre d'evenements.
 *
 * Trois proprietes independantes sont eprouvees, et il faut les trois :
 *
 *  - **Contenu** — chaque document reconstruit redonne son empreinte scellee.
 *    Detecte l'alteration d'un fait.
 *  - **Ordre** — chaque maillon pointe vers l'empreinte du precedent. Detecte la
 *    suppression ou l'insertion d'un fait, que le controle de contenu seul
 *    laisserait passer : un evenement retire laisse les autres intacts.
 *  - **Publication** — la preuve d'inclusion mene a une racine que l'operateur
 *    ne controle plus. C'est ce qui empeche de reecrire toute la chaine de bout
 *    en bout et de la re-sceller.
 */
@Injectable()
export class EventChainVerificationService {
  private readonly logger = new Logger(EventChainVerificationService.name);

  constructor(
    @InjectRepository(AnchorBatch)
    private readonly batches: Repository<AnchorBatch>,
    @InjectRepository(Transaction)
    private readonly transactions: Repository<Transaction>,
    private readonly eventsService: TransactionEventsService,
    private readonly xsdValidator: XsdValidatorService,
    private readonly client: EvmAnchorClient,
  ) {}

  async verify(transactionReference: string): Promise<EventChainReport> {
    const chain = await this.eventsService.findChain(transactionReference);
    const transaction = await this.transactions.findOne({
      where: { reference: transactionReference },
    });
    const findings: string[] = [];
    const verifiedAt = new Date();

    if (chain.length === 0) {
      const closureExpected = this.isClosureExpected(transaction, chain);
      findings.push(
        closureExpected
          ? 'Le dossier est dans un etat final mais toute sa chaine d evenements a disparu.'
          : 'Aucun evenement consigne pour cette transaction : rien a verifier.',
      );
      return {
        transactionReference,
        verdict: closureExpected ? 'TAMPERED' : 'EMPTY',
        closed: false,
        finalProofAnchored: false,
        transactionMatchesLedger: null,
        declaredEventCount: null,
        eventCount: 0,
        anchoredCount: 0,
        head: null,
        events: [],
        findings,
        verifiedAt,
      };
    }

    const results: EventVerification[] = [];
    let tampered = false;
    let chainUnavailable = false;
    let anchoredCount = 0;

    if (!transaction) {
      tampered = true;
      findings.push('La transaction referencee par le registre est introuvable.');
    }

    for (const [index, event] of chain.entries()) {
      const result = await this.verifyEvent(event, index === 0 ? null : chain[index - 1]);
      results.push(result);

      if (!result.xsdValid || !result.fingerprintMatches || !result.chainIntact) tampered = true;
      if (result.anchorVerified === true) anchoredCount += 1;
      if (result.anchorVerified === null && event.anchorStatus === AnchorStatus.ANCHORED) {
        chainUnavailable = true;
      }
      if (result.anchorVerified === false) tampered = true;
    }

    // Les rangs doivent former une suite continue : un trou signale une
    // suppression que le chainage seul pourrait ne pas revéler si l'on a retire
    // le dernier maillon.
    const expected = chain.map((_, index) => index + 1);
    const actual = chain.map((event) => event.sequence);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      tampered = true;
      findings.push(
        `Les rangs ne forment pas une suite continue : attendu ${expected.join(', ')}, ` +
          `constate ${actual.join(', ')}. Au moins un evenement a ete retire.`,
      );
    }

    // --- Preuve de synthese --------------------------------------------------
    //
    // Le chainage et la continuite des rangs ne protegent pas la queue : retirer
    // les N derniers faits laisse une chaine 1..M coherente. La cloture declare
    // le total attendu, ce qui ferme cette derniere ouverture.
    const closing = chain.find((event) => event.eventType === TransactionEventType.CASE_CLOSED);
    const closingResult =
      closing === undefined
        ? undefined
        : results[chain.findIndex((event) => event.id === closing.id)];
    const finalProofAnchored = closingResult?.anchorVerified === true;
    const declaredEventCount = closing?.closureEventCount ?? null;
    const closureExpected = this.isClosureExpected(transaction, chain);

    if (closing) {
      if (declaredEventCount !== chain.length) {
        tampered = true;
        findings.push(
          `La cloture declare ${String(declaredEventCount)} faits, la chaine en compte ` +
            `${chain.length} : des evenements ont ete retires.`,
        );
      }

      const expectedHead = chain[chain.indexOf(closing) - 1]?.fingerprint ?? null;
      if (
        expectedHead !== null &&
        closing.closureChainHead?.toLowerCase() !== expectedHead.toLowerCase()
      ) {
        tampered = true;
        findings.push('Le sommet de chaine declare par la cloture ne correspond pas.');
      }

      if (closing.sequence !== chain.length) {
        tampered = true;
        findings.push(
          'La cloture n est pas le dernier fait : des evenements ont ete ajoutes apres elle.',
        );
      }
    } else if (closureExpected) {
      tampered = true;
      findings.push(
        'Le dossier est dans un etat final mais son evenement de cloture est absent : ' +
          'la queue du registre a ete tronquee ou la cloture n a pas ete consignee.',
      );
    }

    // --- Confrontation de la ligne courante au registre ----------------------
    //
    // Le registre remplace le scellement d'instantane. Verifier la seule chaine
    // prouverait que les faits sont intacts, sans rien dire de la ligne
    // `transactions` : un IBAN beneficiaire modifie apres coup passerait au
    // travers. C'est ce controle qui rend le remplacement equivalent.
    const opening = chain.find((event) => event.creditorIban !== null);
    let transactionMatchesLedger: boolean | null = null;

    if (opening && transaction) {
      const divergences = (
        [
          ['IBAN du donneur d ordre', opening.debtorIban, transaction.debtorIban],
          ['nom du donneur d ordre', opening.debtorName, transaction.debtorName],
          ['IBAN du beneficiaire', opening.creditorIban, transaction.creditorIban],
          ['nom du beneficiaire', opening.creditorName, transaction.creditorName],
          ['libelle', opening.endToEndLabel, transaction.endToEndLabel],
          ['montant', opening.expectedAmount.toFixed(2), Number(transaction.amount).toFixed(2)],
          ['devise', opening.currency, transaction.currency],
        ] as [string, string | null, string | null][]
      ).filter(([, consigned, current]) => (consigned ?? null) !== (current ?? null));

      transactionMatchesLedger = divergences.length === 0;

      if (!transactionMatchesLedger) {
        tampered = true;
        findings.push(
          'ALTERATION DETECTEE : la ligne ne correspond plus a ce que l ouverture a ' +
            `consigne (${divergences.map(([champ]) => champ).join(', ')}).`,
        );
      }
    }

    const head = chain[chain.length - 1].fingerprint;

    if (tampered) {
      findings.push('ALTERATION DETECTEE dans le registre d evenements.');
    } else if (chainUnavailable) {
      findings.push(
        'Chaine injoignable : contenu et ordre sont confirmes, la publication n a pas pu etre verifiee.',
      );
    } else if (!finalProofAnchored) {
      findings.push(
        closing
          ? 'La preuve finale attend le prochain lot d ancrage.'
          : 'Dossier encore ouvert : aucun etat intermediaire n est ancre.',
      );
    } else {
      findings.push(
        `Les ${chain.length} evenements sont intacts et ordonnes. La cloture ancree ` +
          `engage tout l historique ; sommet de chaine : ${head}.`,
      );
      findings.push('Dossier clos : le total declare fait foi, aucune troncature possible.');
    }

    return {
      transactionReference,
      verdict: tampered
        ? 'TAMPERED'
        : chainUnavailable
          ? 'CHAIN_UNAVAILABLE'
          : !finalProofAnchored
            ? 'PARTIALLY_ANCHORED'
            : 'VERIFIED',
      closed: closing !== undefined,
      finalProofAnchored,
      transactionMatchesLedger,
      declaredEventCount,
      eventCount: chain.length,
      anchoredCount,
      head,
      events: results,
      findings,
      verifiedAt,
    };
  }

  /**
   * Une cloture est attendue des que l'etat courant ou un fait encore present
   * prouve que le dossier a atteint une issue sans action restante.
   *
   * Croiser les deux sources est important : une troncature peut retirer le fait
   * terminal, tandis qu'une alteration de la ligne courante peut tenter de
   * masquer qu'elle etait finale.
   */
  private isClosureExpected(
    transaction: Transaction | null,
    chain: readonly TransactionEvent[],
  ): boolean {
    return (
      (transaction?.paymentChannel === PaymentChannel.LEGACY_TRANSFER &&
        (transaction.status === TransactionStatus.COMPLETED ||
          transaction.status === TransactionStatus.FAILED)) ||
      (transaction?.providerStatus === ProviderStatus.FAILED &&
        transaction.reconciliationStatus === ReconciliationStatus.NOT_APPLICABLE) ||
      transaction?.reconciliationStatus === ReconciliationStatus.MATCHED ||
      transaction?.refundStatus === RefundStatus.COMPLETED ||
      chain.some(
        (event) =>
          event.eventType === TransactionEventType.TRANSFER_COMPLETED ||
          event.eventType === TransactionEventType.TRANSFER_FAILED ||
          event.eventType === TransactionEventType.PROVIDER_FAILED ||
          event.eventType === TransactionEventType.RECONCILIATION_MATCHED ||
          event.eventType === TransactionEventType.REFUND_COMPLETED,
      )
    );
  }

  private async verifyEvent(
    event: TransactionEvent,
    previous: TransactionEvent | null,
  ): Promise<EventVerification> {
    const findings: string[] = [];

    // --- Contenu -------------------------------------------------------------
    const xml = this.eventsService.rebuildDocument(event);
    const violations = await this.xsdValidator.validate(xml, SCHEMAS.transactionEvent);
    const xsdValid = violations.length === 0;
    if (!xsdValid) {
      findings.push(`Document non conforme : ${violations.map((v) => v.message).join(' | ')}`);
    }

    const recomputed = computeFingerprint(event.fingerprintSalt, xml);
    const fingerprintMatches = recomputed.toLowerCase() === event.fingerprint.toLowerCase();
    if (!fingerprintMatches) {
      findings.push('Le fait consigne ne produit plus son empreinte scellee.');
    }

    // --- Ordre ---------------------------------------------------------------
    const expectedPrevious = previous?.fingerprint ?? null;
    const chainIntact =
      (event.previousFingerprint ?? null)?.toLowerCase() === expectedPrevious?.toLowerCase() ||
      (event.previousFingerprint === null && expectedPrevious === null);

    if (!chainIntact) {
      findings.push(
        previous === null
          ? 'Le premier maillon reference un predecesseur : la tete de chaine a ete retiree.'
          : 'Le maillon ne pointe pas vers l empreinte du fait precedent.',
      );
    }

    // --- Publication ---------------------------------------------------------
    const anchorVerified = await this.verifyAnchor(event, findings);

    return {
      sequence: event.sequence,
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      xsdValid,
      fingerprintMatches,
      chainIntact,
      anchorVerified,
      findings,
    };
  }

  /** `null` = non ancre ou chaine injoignable ; le verdict global les distingue. */
  private async verifyAnchor(event: TransactionEvent, findings: string[]): Promise<boolean | null> {
    if (event.anchorStatus !== AnchorStatus.ANCHORED || !event.batchId || !event.merkleProof) {
      return null;
    }

    const batch = await this.batches.findOne({ where: { id: event.batchId } });
    if (!batch) {
      findings.push(`Lot ${event.batchId} introuvable : preuve inexploitable.`);
      return false;
    }

    const leaf = toLeaf(event.fingerprint);
    if (!verifyProof(leaf, event.merkleProof, batch.merkleRoot)) {
      findings.push('La preuve d inclusion ne mene pas a la racine du lot.');
      return false;
    }

    try {
      const onChain = await this.client.getBatch(batch.id);
      if (!onChain) {
        findings.push('Lot marque ancre en base mais absent de la chaine.');
        return false;
      }
      if (onChain.merkleRoot.toLowerCase() !== batch.merkleRoot.toLowerCase()) {
        findings.push(
          `Racine en base (${batch.merkleRoot}) differente de celle publiee (${onChain.merkleRoot}).`,
        );
        return false;
      }
      return await this.client.verifyInclusion(batch.id, leaf, event.merkleProof);
    } catch (error) {
      this.logger.warn({
        event: 'event-chain.chain.unavailable',
        reference: event.transactionReference,
        reason: error instanceof Error ? error.message : 'erreur inconnue',
      });
      return null;
    }
  }
}
