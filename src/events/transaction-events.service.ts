import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { EntityManager, QueryFailedError, Repository } from 'typeorm';
import { AnchorStatus } from '../blockchain/enums/anchor-status.enum';
import { computeFingerprint, generateSalt } from '../blockchain/fingerprint.util';
import { getCorrelationId } from '../common/context/request-context';
import { SCHEMAS, XsdValidatorService } from '../xml/xsd-validator.service';
import { LedgerPostingService } from '../accounting/ledger-posting.service';
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

/**
 * Point de sauvegarde encadrant une tentative d'insertion.
 *
 * PostgreSQL avorte **toute** la transaction sur une violation de contrainte :
 * sans cela, la premiere collision de rang rendrait inutilisable la transaction
 * metier englobante, et la tentative suivante echouerait sur `25P02` au lieu de
 * rejouer. Le nom est fixe car les tentatives sont strictement sequentielles.
 */
const SEQUENCE_SAVEPOINT = 'transaction_event_attempt';

/**
 * Evenements portant les parties du virement.
 *
 * Consignees une seule fois, a l'ouverture : elles ne changent pas, et les
 * repeter a chaque fait alourdirait la chaine sans rien prouver de plus. C'est
 * contre cet enregistrement que la verification confronte la ligne courante.
 */
const OPENING_EVENTS: ReadonlySet<TransactionEventType> = new Set([
  TransactionEventType.TRANSFER_INITIATED,
  TransactionEventType.PAYMENT_INITIATED,
]);

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
    private readonly posting: LedgerPostingService,
  ) {}

  /**
   * Consigne un fait, scelle et chaine au precedent.
   *
   * @throws Error si le document produit ne respecte pas son XSD, ou si le rang
   *         ne peut pas etre obtenu apres plusieurs tentatives.
   */
  async record(input: RecordEventInput, manager?: EntityManager): Promise<TransactionEvent> {
    const { transaction } = input;
    const repository = manager?.getRepository(TransactionEvent) ?? this.events;

    for (let attempt = 1; attempt <= MAX_SEQUENCE_ATTEMPTS; attempt += 1) {
      const previous = await repository.findOne({
        where: { transactionReference: transaction.reference },
        order: { sequence: 'DESC' },
      });
      const isClosing = input.type === TransactionEventType.CASE_CLOSED;
      const isOpening = OPENING_EVENTS.has(input.type);

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
        // Derives du sommet reel lu pour cette tentative. Si une insertion
        // concurrente prend le rang, la tentative suivante recalcule les deux
        // valeurs avec le nouveau sommet au lieu de sceller une synthese perimee.
        closureEventCount: isClosing ? (previous?.sequence ?? 0) + 1 : null,
        closureChainHead: isClosing ? (previous?.fingerprint ?? null) : null,

        // Parties consignees a la seule ouverture : elles ne changent pas, et les
        // repeter a chaque fait alourdirait la chaine sans rien prouver de plus.
        // C'est cet enregistrement que la verification confronte a la ligne
        // courante — sans lui, une modification d'IBAN resterait indetectable.
        debtorIban: isOpening ? transaction.debtorIban : null,
        debtorName: isOpening ? transaction.debtorName : null,
        creditorIban: isOpening ? transaction.creditorIban : null,
        creditorName: isOpening ? transaction.creditorName : null,
        endToEndLabel: isOpening ? transaction.endToEndLabel : null,
      };

      const xml = this.xmlBuilder.build(draft);
      await this.xsdValidator.assertValid(xml, SCHEMAS.transactionEvent);

      const salt = generateSalt();
      const event = repository.create({
        ...draft,
        fingerprint: computeFingerprint(salt, xml),
        fingerprintSalt: salt,
        recordFormatVersion: EVENT_RECORD_FORMAT_VERSION,
        anchorStatus: AnchorStatus.PENDING,
      });

      // Dans une transaction metier englobante, l'insertion est encadree par un
      // point de sauvegarde : une collision de rang doit pouvoir etre rejouee
      // sans emporter l'ecriture metier deja effectuee.
      const nested = manager?.queryRunner?.isTransactionActive === true;
      if (nested) await manager.query(`SAVEPOINT ${SEQUENCE_SAVEPOINT}`);

      try {
        const saved = await repository.save(event);

        // La consequence comptable appartient a la meme transaction que le fait.
        // Un fait monetaire sans son ecriture rendrait le journal faux sans que
        // rien ne le signale — et le journal est append-only, donc irreparable.
        await this.posting.post(saved, transaction, manager);

        if (nested) await manager.query(`RELEASE SAVEPOINT ${SEQUENCE_SAVEPOINT}`);

        this.logger.log({
          event: 'transaction-event.recorded',
          type: saved.eventType,
          reference: saved.transactionReference,
          sequence: saved.sequence,
          fingerprint: saved.fingerprint,
        });

        return saved;
      } catch (error) {
        // Rend la transaction englobante de nouveau utilisable : sans ce retour
        // arriere, toute requete ulterieure echouerait, y compris la relecture
        // du sommet de chaine faite par la tentative suivante.
        if (nested) await manager.query(`ROLLBACK TO SAVEPOINT ${SEQUENCE_SAVEPOINT}`);

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

  /**
   * Clot le dossier par une preuve de synthese.
   *
   * ## Ce que la cloture apporte
   *
   * Le chainage protege l'ordre et le contenu, mais laisse une ouverture : la
   * troncature de queue. Retirer les N derniers faits produit une chaine 1..M
   * parfaitement coherente, indiscernable d'un dossier encore en cours.
   *
   * L'evenement de cloture declare le nombre total de faits et le sommet de
   * chaine. Ancre, il rend la troncature detectable : le compte publie ne
   * correspondrait plus a ce que la base contient.
   *
   * Il fournit accessoirement a un tiers une valeur unique de 32 octets qui
   * engage tout le dossier, sans qu'il ait a conserver la chaine entiere.
   *
   * Idempotent : un dossier deja clos n'est jamais reclos.
   */
  async closeCase(
    transaction: Transaction,
    detail?: string,
    manager?: EntityManager,
  ): Promise<TransactionEvent | null> {
    // Lire via le meme manager est indispensable : depuis l'exterieur de la
    // transaction englobante, les faits qu'elle vient d'ajouter sont invisibles,
    // et la cloture scellerait un total de faits deja faux.
    const chain = await this.findChain(transaction.reference, manager);

    if (chain.length === 0) return null;
    if (chain.some((event) => event.eventType === TransactionEventType.CASE_CLOSED)) {
      return null;
    }

    try {
      return await this.record(
        {
          type: TransactionEventType.CASE_CLOSED,
          transaction,
          detail: detail ?? 'Dossier clos',
        },
        manager,
      );
    } catch (error) {
      // L'index partiel garantit une seule cloture par dossier. Deux appels
      // concurrents peuvent tous deux constater l'absence avant que l'un gagne
      // l'insertion ; le perdant renvoie alors la cloture existante.
      if (this.isUniqueViolation(error)) {
        const existing = await (manager?.getRepository(TransactionEvent) ?? this.events).findOne({
          where: {
            transactionReference: transaction.reference,
            eventType: TransactionEventType.CASE_CLOSED,
          },
        });
        if (existing) return existing;
      }
      throw error;
    }
  }

  /** Chaine complete d'une transaction, du plus ancien au plus recent. */
  async findChain(
    transactionReference: string,
    manager?: EntityManager,
  ): Promise<TransactionEvent[]> {
    return (manager?.getRepository(TransactionEvent) ?? this.events).find({
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
    const driverError = this.driverError(error);
    return (
      driverError?.code === PG_UNIQUE_VIOLATION &&
      `${driverError.constraint ?? ''}`.includes('sequence')
    );
  }

  private isUniqueViolation(error: unknown): boolean {
    return this.driverError(error)?.code === PG_UNIQUE_VIOLATION;
  }

  private driverError(error: unknown): { code?: string; constraint?: string } | undefined {
    if (!(error instanceof QueryFailedError)) return undefined;
    return error.driverError as { code?: string; constraint?: string } | undefined;
  }
}
