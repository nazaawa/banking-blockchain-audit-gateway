import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';
import { AnchorStatus } from '../../blockchain/enums/anchor-status.enum';
import { TransactionStatus } from '../enums/transaction-status.enum';

/**
 * Convertit le type `numeric` PostgreSQL (renvoye en `string` par le driver pg)
 * en `number` cote applicatif, tout en conservant la precision decimale en base.
 *
 * Note : au-dela de 2^53 unites monetaires le `number` JavaScript deviendrait
 * insuffisant ; la garde `TRANSFER_MAX_AMOUNT` maintient les montants tres en
 * deca de cette limite.
 */
const numericTransformer = {
  to: (value: number | null): number | null => value,
  from: (value: string | null): number | null => (value === null ? null : Number.parseFloat(value)),
};

/** Demande de virement enregistree par l'API. */
@Entity('transactions')
@Index('idx_transactions_status', ['status'])
@Index('idx_transactions_created_at', ['createdAt'])
export class Transaction {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Reference fonctionnelle unique exposee au client (`TRF-YYYYMMDD-XXXXXXXX`). */
  @Column({ type: 'varchar', length: 32, unique: true })
  reference!: string;

  /**
   * Cle d'idempotence fournie par l'appelant (en-tete `Idempotency-Key`).
   * Un rejeu avec la meme cle renvoie la transaction initiale sans nouvel appel SOAP.
   */
  @Column({ name: 'idempotency_key', type: 'varchar', length: 128, nullable: true, unique: true })
  idempotencyKey!: string | null;

  @Column({ type: 'enum', enum: TransactionStatus, default: TransactionStatus.PENDING })
  status!: TransactionStatus;

  @Column({ name: 'debtor_iban', type: 'varchar', length: 34 })
  debtorIban!: string;

  @Column({ name: 'debtor_name', type: 'varchar', length: 140, nullable: true })
  debtorName!: string | null;

  @Column({ name: 'creditor_iban', type: 'varchar', length: 34 })
  creditorIban!: string;

  @Column({ name: 'creditor_name', type: 'varchar', length: 140 })
  creditorName!: string;

  @Column({ type: 'numeric', precision: 18, scale: 2, transformer: numericTransformer })
  amount!: number;

  @Column({ type: 'char', length: 3 })
  currency!: string;

  /** Libelle libre communique au beneficiaire. */
  @Column({ name: 'end_to_end_label', type: 'varchar', length: 140, nullable: true })
  endToEndLabel!: string | null;

  /** Montant en toutes lettres, restitue par le service SOAP. */
  @Column({ name: 'amount_in_words', type: 'text', nullable: true })
  amountInWords!: string | null;

  @Column({ name: 'soap_operation', type: 'varchar', length: 64, nullable: true })
  soapOperation!: string | null;

  @Column({ name: 'soap_duration_ms', type: 'int', nullable: true })
  soapDurationMs!: number | null;

  @Column({ name: 'soap_attempts', type: 'int', nullable: true })
  soapAttempts!: number | null;

  @Column({ name: 'fault_code', type: 'varchar', length: 128, nullable: true })
  faultCode!: string | null;

  @Column({ name: 'fault_string', type: 'varchar', length: 1024, nullable: true })
  faultString!: string | null;

  /** Motif d'echec lisible, expose au client sur une transaction FAILED. */
  @Column({ name: 'failure_reason', type: 'varchar', length: 512, nullable: true })
  failureReason!: string | null;

  @Column({ name: 'correlation_id', type: 'varchar', length: 128 })
  correlationId!: string;

  /** Horodatage de fin de traitement (succes ou echec definitif). */
  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  // ---------------------------------------------------------------------------
  // Scellement cryptographique et ancrage blockchain
  // ---------------------------------------------------------------------------

  /**
   * Empreinte du document XML scelle : `keccak256(sel ‖ TransferRecord)`.
   * Calculee une seule fois, quand la transaction atteint un etat terminal.
   */
  @Column({ name: 'fingerprint', type: 'varchar', length: 66, nullable: true })
  fingerprint!: string | null;

  /**
   * Sel aleatoire de 32 octets, propre a cette transaction.
   *
   * Sans lui, l'empreinte publiee serait attaquable par force brute : un IBAN
   * suit un format public et un montant se devine. Le sel ne quitte jamais la
   * base — il est necessaire a la verification, jamais a la publication.
   */
  @Column({ name: 'fingerprint_salt', type: 'varchar', length: 66, nullable: true })
  fingerprintSalt!: string | null;

  /** Version du format de serialisation ayant produit l'empreinte. */
  @Column({ name: 'record_format_version', type: 'varchar', length: 8, nullable: true })
  recordFormatVersion!: string | null;

  @Column({ name: 'sealed_at', type: 'timestamptz', nullable: true })
  sealedAt!: Date | null;

  @Index('idx_transactions_anchor_status')
  @Column({
    name: 'anchor_status',
    type: 'enum',
    enum: AnchorStatus,
    default: AnchorStatus.NOT_SEALED,
  })
  anchorStatus!: AnchorStatus;

  /** Lot d'ancrage auquel la transaction a ete rattachee. */
  @Column({ name: 'batch_id', type: 'uuid', nullable: true })
  batchId!: string | null;

  /** Position de la feuille dans l'arbre du lot : sans elle, la preuve est inverifiable. */
  @Column({ name: 'leaf_index', type: 'int', nullable: true })
  leafIndex!: number | null;

  /** Chemin de hashs freres, de la feuille vers la racine. */
  @Column({ name: 'merkle_proof', type: 'jsonb', nullable: true })
  merkleProof!: string[] | null;

  /** Verrouillage optimiste : protege contre les mises a jour concurrentes. */
  @VersionColumn()
  version!: number;
}
