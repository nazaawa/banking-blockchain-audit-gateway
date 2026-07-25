import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { QueryFailedError, Repository } from 'typeorm';
import { AnchorStatus } from '../blockchain/enums/anchor-status.enum';
import { computeFingerprint, generateSalt } from '../blockchain/fingerprint.util';
import { getCorrelationId } from '../common/context/request-context';
import { SCHEMAS, XsdValidatorService } from '../xml/xsd-validator.service';
import type { Transaction } from '../transactions/entities/transaction.entity';
import { TransactionEvent } from './entities/transaction-event.entity';
import { TransactionEventType } from './enums/transaction-event.enum';
import {
  EVENT_RECORD_FORMAT_VERSION,
  TransactionEventXmlBuilder,
  type SerializableEvent,
} from './transaction-event-xml.builder';

const PG_UNIQUE_VIOLATION = '23505';

/** Tentatives d'insertion en cas de collision de rang sur une meme transaction. */
const MAX_SEQUENCE_ATTEMPTS = 5;

/** Fait a consigner. L'appelant decrit ce qui s'est produit, pas comment le prouver. */
export interface RecordEventInput {
  type: TransactionEventType;
  transaction: Transaction;
  /** Montant effectivement constate, s'il differe de l'attendu ou s'il est notifie. */
  observedAmount?: number | null;
  observedCurrency?: string | null;
  detail?: string | null;
  occurredAt?: Date;
}

/**
 * Registre append-only des faits metier.
 *
 * ## Ce que ce service garantit
 *
 * 1. **Scellement a la naissance** — l'empreinte est calculee avant l'insertion.
 *    La ligne n'existe jamais dans un etat non prouve, et le scellement fait
 *    partie de ce que le declencheur d'immuabilite protege.
 * 2. **Chainage** — chaque evenement porte l'empreinte du precedent. Le rang est
 *    unique par transaction : deux insertions concurrentes ne peuvent pas
 *    produire deux chaines paralleles, la perdante rejoue sur le nouveau sommet.
 * 3. **Non-destruction** — aucune preuve anterieure n'est modifiee ni remplacee.
 *    Un fait nouveau s'ajoute, il ne corrige pas.
 *
 * ## Politique d'echec
 *
 * Contrairement au scellement d'instantane, un echec ici n'est pas absorbable :
 * un evenement manquant creerait un trou dans la chaine, et tous les faits
 * suivants pointeraient vers une empreinte qui n'existe pas. L'erreur est donc
 * propagee — c'est a l'appelant de decider si l'operation metier peut aboutir
 * sans sa trace.
 */
@Injectable()
export class TransactionEventsService {
  private readonly logger = new Logger(TransactionEventsService.name);

  constructor(
    @InjectRepository(TransactionEvent)
    private readonly events: Repository<TransactionEvent>,
    private readonly xmlBuilder: TransactionEventXmlBuilder,
    private readonly xsdValidator: XsdValidatorService,
  ) {}

  /**
   * Consigne un fait, scelle et chaine au precedent.
   *
   * @throws Error si le document produit ne respecte pas son XSD, ou si le rang
   *         ne peut pas etre obtenu apres plusieurs tentatives.
   */
  async record(input: RecordEventInput): Promise<TransactionEvent> {
    const { transaction } = input;

    for (let attempt = 1; attempt <= MAX_SEQUENCE_ATTEMPTS; attempt += 1) {
      const previous = await this.findLatest(transaction.reference);

      const draft: SerializableEvent = {
        id: randomUUID(),
        eventType: input.type,
        sequence: (previous?.sequence ?? 0) + 1,
        transactionReference: transaction.reference,
        providerReference: transaction.aggregatorReference,
        bankReference: transaction.soapOperation,
        providerStatus: transaction.providerStatus,
        bankStatus: transaction.bankStatus,
        reconciliationStatus: transaction.reconciliationStatus,
        refundStatus: transaction.refundStatus ?? null,
        caseStatus: transaction.caseStatus ?? null,
        expectedAmount: Number(transaction.amount),
        observedAmount: input.observedAmount ?? null,
        currency: transaction.currency,
        observedCurrency: input.observedCurrency ?? null,
        occurredAt: input.occurredAt ?? new Date(),
        correlationId: transaction.correlationId || getCorrelationId(),
        detail: input.detail ?? null,
        previousFingerprint: previous?.fingerprint ?? null,
      };

      const xml = this.xmlBuilder.build(draft);
      await this.xsdValidator.assertValid(xml, SCHEMAS.transactionEvent);

      const salt = generateSalt();
      const event = this.events.create({
        ...draft,
        fingerprint: computeFingerprint(salt, xml),
        fingerprintSalt: salt,
        recordFormatVersion: EVENT_RECORD_FORMAT_VERSION,
        anchorStatus: AnchorStatus.PENDING,
      });

      try {
        const saved = await this.events.save(event);

        this.logger.log({
          event: 'transaction-event.recorded',
          type: saved.eventType,
          reference: saved.transactionReference,
          sequence: saved.sequence,
          fingerprint: saved.fingerprint,
        });

        return saved;
      } catch (error) {
        // Un autre processus a pris le rang : la chaine a un nouveau sommet, il
        // faut rechainer sur lui plutot que forcer une branche parallele.
        if (this.isSequenceCollision(error) && attempt < MAX_SEQUENCE_ATTEMPTS) {
          this.logger.warn({
            event: 'transaction-event.sequence.collision',
            reference: transaction.reference,
            attempt,
          });
          continue;
        }
        throw error;
      }
    }

    throw new Error(
      `Impossible de consigner l'evenement ${input.type} pour ${transaction.reference} ` +
        `apres ${MAX_SEQUENCE_ATTEMPTS} tentatives`,
    );
  }

  /** Chaine complete d'une transaction, du plus ancien au plus recent. */
  async findChain(transactionReference: string): Promise<TransactionEvent[]> {
    return this.events.find({
      where: { transactionReference },
      order: { sequence: 'ASC' },
    });
  }

  async findLatest(transactionReference: string): Promise<TransactionEvent | null> {
    return this.events.findOne({
      where: { transactionReference },
      order: { sequence: 'DESC' },
    });
  }

  /** Reconstruit le document canonique d'un evenement, pour verification. */
  rebuildDocument(event: TransactionEvent): string {
    return this.xmlBuilder.build(event);
  }

  private isSequenceCollision(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) return false;
    const driverError = error.driverError as { code?: string; constraint?: string } | undefined;
    return (
      driverError?.code === PG_UNIQUE_VIOLATION &&
      `${driverError.constraint ?? ''}`.includes('sequence')
    );
  }
}
