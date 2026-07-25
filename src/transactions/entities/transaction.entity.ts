import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';
import { encryptedColumn } from '../../security/field-cipher';
import { AnchorBatch } from '../../blockchain/entities/anchor-batch.entity';
import { AnchorStatus } from '../../blockchain/enums/anchor-status.enum';
import {
  BankProcessingStatus,
  CaseStatus,
  MobileMoneyOperator,
  PaymentChannel,
  ProviderStatus,
  ReconciliationStatus,
  RefundStatus,
} from '../../mobile-money/enums/mobile-money.enum';
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
/**
 * Invariants entre dimensions de statut, imposes par la base.
 *
 * Ils reprennent ceux de `TransactionStateMachine`. Le doublon est voulu : la
 * machine arrete l'erreur au plus pres de sa cause et la nomme, la base ferme
 * ce qui la contourne — script d'exploitation, correctif manuel, futur service.
 *
 * Ils sont declares ici **et** en migration : sans le decorateur, `synchronize`
 * les supprimerait silencieusement en developpement.
 *
 * Seule la table de transitions reste applicative : elle a besoin de connaitre
 * l'etat de depart, qu'une contrainte `CHECK` ne voit pas.
 */
@Check(
  'CHK_transactions_bank_requires_provider',
  `"payment_channel"::text <> 'MOBILE_MONEY' OR "bank_status" IS NULL OR "bank_status"::text = 'NOT_STARTED' OR "provider_status"::text = 'CONFIRMED'`,
)
@Check(
  'CHK_transactions_refund_requires_collection',
  `"payment_channel"::text <> 'MOBILE_MONEY' OR "refund_status" IS NULL OR "refund_status"::text = 'NOT_REQUIRED' OR "provider_status"::text = 'CONFIRMED'`,
)
@Check(
  'CHK_transactions_resolved_case_needs_extinct_debt',
  `"case_status"::text <> 'RESOLVED' OR "refund_status" IS NULL OR "refund_status"::text IN ('COMPLETED', 'NOT_REQUIRED')`,
)
@Check(
  'CHK_transactions_matched_needs_both_legs',
  `"reconciliation_status"::text <> 'MATCHED' OR "payment_channel"::text <> 'MOBILE_MONEY' OR ("provider_status"::text = 'CONFIRMED' AND "bank_status"::text = 'COMPLETED')`,
)
@Check(
  'CHK_transactions_blocked_bank_needs_gap',
  `"bank_status"::text <> 'BLOCKED' OR "reconciliation_status"::text IN ('AMOUNT_MISMATCH', 'CURRENCY_MISMATCH')`,
)
@Entity('transactions')
@Index('idx_transactions_status', ['status'])
@Index('idx_transactions_created_at', ['createdAt'])
@Index('idx_transactions_reconciliation', ['paymentChannel', 'reconciliationStatus'])
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

  @Column({
    name: 'payment_channel',
    type: 'enum',
    enum: PaymentChannel,
    default: PaymentChannel.LEGACY_TRANSFER,
  })
  paymentChannel!: PaymentChannel;

  @Column({
    name: 'debtor_iban',
    type: 'varchar',
    length: 512,
    transformer: encryptedColumn('transactions.debtor_iban'),
  })
  debtorIban!: string;

  @Column({
    name: 'debtor_name',
    type: 'varchar',
    length: 512,
    nullable: true,
    transformer: encryptedColumn('transactions.debtor_name'),
  })
  debtorName!: string | null;

  @Column({
    name: 'creditor_iban',
    type: 'varchar',
    length: 512,
    transformer: encryptedColumn('transactions.creditor_iban'),
  })
  creditorIban!: string;

  @Column({
    name: 'creditor_name',
    type: 'varchar',
    length: 512,
    transformer: encryptedColumn('transactions.creditor_name'),
  })
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

  // ---------------------------------------------------------------------------
  // Cycle de vie Mobile Money
  // ---------------------------------------------------------------------------

  @Column({
    name: 'mobile_money_operator',
    type: 'enum',
    enum: MobileMoneyOperator,
    nullable: true,
  })
  mobileMoneyOperator!: MobileMoneyOperator | null;

  @Column({ name: 'payer_msisdn', type: 'varchar', length: 16, nullable: true })
  payerMsisdn!: string | null;

  @Column({
    name: 'aggregator_reference',
    type: 'varchar',
    length: 64,
    nullable: true,
    unique: true,
  })
  aggregatorReference!: string | null;

  @Column({
    name: 'provider_status',
    type: 'enum',
    enum: ProviderStatus,
    nullable: true,
  })
  providerStatus!: ProviderStatus | null;

  @Column({
    name: 'bank_status',
    type: 'enum',
    enum: BankProcessingStatus,
    nullable: true,
  })
  bankStatus!: BankProcessingStatus | null;

  @Column({
    name: 'reconciliation_status',
    type: 'enum',
    enum: ReconciliationStatus,
    nullable: true,
  })
  reconciliationStatus!: ReconciliationStatus | null;

  @Column({
    name: 'aggregator_amount',
    type: 'numeric',
    precision: 18,
    scale: 2,
    transformer: numericTransformer,
    nullable: true,
  })
  aggregatorAmount!: number | null;

  @Column({ name: 'aggregator_currency', type: 'char', length: 3, nullable: true })
  aggregatorCurrency!: string | null;

  /**
   * Commission retenue par la passerelle, **figee** a la confirmation.
   *
   * Elle est stockee plutot que recalculee : le taux est une donnee de
   * configuration, susceptible de changer. Recalculer a la lecture ferait
   * varier retroactivement des ecritures comptables deja passees.
   */
  @Column({
    name: 'fee_amount',
    type: 'numeric',
    precision: 18,
    scale: 2,
    transformer: numericTransformer,
    default: 0,
  })
  feeAmount!: number;

  @Column({ name: 'mobile_money_confirmed_at', type: 'timestamptz', nullable: true })
  mobileMoneyConfirmedAt!: Date | null;

  @Column({ name: 'reconciled_at', type: 'timestamptz', nullable: true })
  reconciledAt!: Date | null;

  @Column({ name: 'reconciliation_reason', type: 'varchar', length: 512, nullable: true })
  reconciliationReason!: string | null;

  /**
   * Obligation de remboursement envers le payeur.
   *
   * Dimension distincte du statut du virement : un virement non execute alors
   * que le fournisseur a encaisse laisse une dette, que `TransactionStatus`
   * seul ne peut pas exprimer.
   */
  @Column({
    name: 'refund_status',
    type: 'enum',
    enum: RefundStatus,
    default: RefundStatus.NOT_REQUIRED,
  })
  refundStatus!: RefundStatus;

  /** Suivi de l'action humaine appelee par une anomalie. */
  @Index('idx_transactions_case_status')
  @Column({
    name: 'case_status',
    type: 'enum',
    enum: CaseStatus,
    default: CaseStatus.NONE,
  })
  caseStatus!: CaseStatus;

  /** Motif d'ouverture du dossier, lisible par un operateur. */
  @Column({ name: 'case_reason', type: 'varchar', length: 512, nullable: true })
  caseReason!: string | null;

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

  @ManyToOne(() => AnchorBatch, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'batch_id' })
  batch?: AnchorBatch | null;

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
