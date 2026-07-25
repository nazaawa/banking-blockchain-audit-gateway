import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { AnchorBatch } from '../../blockchain/entities/anchor-batch.entity';
import { AnchorStatus } from '../../blockchain/enums/anchor-status.enum';
import { Transaction } from '../../transactions/entities/transaction.entity';
import {
  BankProcessingStatus,
  CaseStatus,
  ProviderStatus,
  ReconciliationStatus,
  RefundStatus,
} from '../../mobile-money/enums/mobile-money.enum';
import { TransactionEventType } from '../enums/transaction-event.enum';

const numericTransformer = {
  to: (value: number | null): number | null => value,
  from: (value: string | null): number | null => (value === null ? null : Number.parseFloat(value)),
};

/**
 * Registre append-only des faits metier.
 *
 * ## Immuabilite
 *
 * Les colonnes factuelles ne changent jamais apres insertion — un declencheur
 * PostgreSQL rejette toute tentative, et le role applicatif n'a pas le droit
 * `DELETE`. Seules les colonnes de preuve (`anchor_status`, `batch_id`,
 * `leaf_index`, `merkle_proof`) restent modifiables : l'ancrage etant differe,
 * il les renseigne apres coup.
 *
 * L'empreinte, elle, est calculee **avant** l'insertion : la ligne nait scellee,
 * et le scellement fait donc partie de ce qui est immuable.
 *
 * ## Chainage
 *
 * `previous_fingerprint` porte l'empreinte de l'evenement precedent de la meme
 * transaction. Retirer ou reordonner un evenement rompt la chaine, meme si son
 * lot Merkle reste valide : les deux mecanismes prouvent des choses
 * differentes — l'inclusion pour l'un, l'ordre pour l'autre.
 */
@Entity('transaction_events')
@Unique('uq_transaction_events_sequence', ['transactionReference', 'sequence'])
@Index('idx_transaction_events_reference', ['transactionReference'])
@Index('idx_transaction_events_type', ['eventType'])
@Index('idx_transaction_events_anchor_status', ['anchorStatus'])
@Index('idx_transaction_events_occurred_at', ['occurredAt'])
@Index('uq_transaction_events_case_closed', ['transactionReference'], {
  unique: true,
  where: `"event_type" = 'CASE_CLOSED'`,
})
export class TransactionEvent {
  @ApiProperty({ format: 'uuid' })
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ApiProperty({ enum: TransactionEventType })
  @Column({ name: 'event_type', type: 'enum', enum: TransactionEventType })
  eventType!: TransactionEventType;

  /** Rang de l'evenement dans la vie de la transaction, a partir de 1. */
  @ApiProperty({ example: 3 })
  @Column({ type: 'int' })
  sequence!: number;

  // --- References ------------------------------------------------------------

  @ApiProperty({ example: 'TRF-20260725-8F3A2C71' })
  @Column({ name: 'transaction_reference', type: 'varchar', length: 32 })
  transactionReference!: string;

  /**
   * Relation declaree pour que l'integrite referentielle existe dans **tous** les
   * modes de provisionnement : sans elle, `synchronize` supprimerait la
   * contrainte creee par la migration, et un evenement orphelin — une preuve qui
   * ne reference rien — redeviendrait possible en developpement.
   */
  @ManyToOne(() => Transaction, { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn({ name: 'transaction_reference', referencedColumnName: 'reference' })
  transaction?: Transaction;

  @ApiPropertyOptional({ description: 'Reference cote agregateur / fournisseur' })
  @Column({ name: 'provider_reference', type: 'varchar', length: 64, nullable: true })
  providerReference!: string | null;

  @ApiPropertyOptional({ description: 'Reference cote back-office bancaire' })
  @Column({ name: 'bank_reference', type: 'varchar', length: 64, nullable: true })
  bankReference!: string | null;

  // --- Etat des jambes au moment du fait -------------------------------------

  @ApiPropertyOptional({ enum: ProviderStatus })
  @Column({ name: 'provider_status', type: 'enum', enum: ProviderStatus, nullable: true })
  providerStatus!: ProviderStatus | null;

  @ApiPropertyOptional({ enum: BankProcessingStatus })
  @Column({ name: 'bank_status', type: 'enum', enum: BankProcessingStatus, nullable: true })
  bankStatus!: BankProcessingStatus | null;

  @ApiPropertyOptional({ enum: ReconciliationStatus })
  @Column({
    name: 'reconciliation_status',
    type: 'enum',
    enum: ReconciliationStatus,
    nullable: true,
  })
  reconciliationStatus!: ReconciliationStatus | null;

  @ApiPropertyOptional({ enum: RefundStatus })
  @Column({ name: 'refund_status', type: 'enum', enum: RefundStatus, nullable: true })
  refundStatus!: RefundStatus | null;

  @ApiPropertyOptional({ enum: CaseStatus })
  @Column({ name: 'case_status', type: 'enum', enum: CaseStatus, nullable: true })
  caseStatus!: CaseStatus | null;

  // --- Montants ---------------------------------------------------------------

  /** Montant commande, tel qu'attendu par la passerelle. */
  @ApiProperty({ example: 1250.75 })
  @Column({
    name: 'expected_amount',
    type: 'numeric',
    precision: 18,
    scale: 2,
    transformer: numericTransformer,
  })
  expectedAmount!: number;

  /** Montant effectivement constate. Absent tant que rien n'a ete notifie. */
  @ApiPropertyOptional({ example: 1.0 })
  @Column({
    name: 'observed_amount',
    type: 'numeric',
    precision: 18,
    scale: 2,
    transformer: numericTransformer,
    nullable: true,
  })
  observedAmount!: number | null;

  @ApiProperty({ example: 'CDF' })
  @Column({ type: 'char', length: 3 })
  currency!: string;

  @ApiPropertyOptional({ description: 'Devise constatee, si differente de l attendue' })
  @Column({ name: 'observed_currency', type: 'char', length: 3, nullable: true })
  observedCurrency!: string | null;

  // --- Contexte ---------------------------------------------------------------

  @ApiProperty()
  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;

  @ApiProperty()
  @Column({ name: 'correlation_id', type: 'varchar', length: 128 })
  correlationId!: string;

  @ApiPropertyOptional({ description: 'Motif lisible du fait consigne' })
  @Column({ type: 'varchar', length: 1024, nullable: true })
  detail!: string | null;

  // --- Chainage et preuve -----------------------------------------------------

  @ApiPropertyOptional({ description: 'Empreinte de l evenement precedent de la transaction' })
  @Column({ name: 'previous_fingerprint', type: 'varchar', length: 66, nullable: true })
  previousFingerprint!: string | null;

  /**
   * Nombre total de faits du dossier, cloture comprise.
   * Renseigne sur le seul evenement de cloture.
   */
  @ApiPropertyOptional({ example: 6 })
  @Column({ name: 'closure_event_count', type: 'int', nullable: true })
  closureEventCount!: number | null;

  /** Sommet de chaine au moment de la cloture : engage tout l'historique. */
  @ApiPropertyOptional()
  @Column({ name: 'closure_chain_head', type: 'varchar', length: 66, nullable: true })
  closureChainHead!: string | null;

  @ApiProperty({ description: 'Empreinte scellee, calculee avant insertion' })
  @Column({ type: 'varchar', length: 66 })
  fingerprint!: string;

  @Column({ name: 'fingerprint_salt', type: 'varchar', length: 66 })
  fingerprintSalt!: string;

  @ApiProperty({ example: '1.0' })
  @Column({ name: 'record_format_version', type: 'varchar', length: 8 })
  recordFormatVersion!: string;

  // --- Ancrage (seules colonnes modifiables apres insertion) ------------------

  @ApiProperty({ enum: AnchorStatus })
  @Column({
    name: 'anchor_status',
    type: 'enum',
    enum: AnchorStatus,
    default: AnchorStatus.PENDING,
  })
  anchorStatus!: AnchorStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @Column({ name: 'batch_id', type: 'uuid', nullable: true })
  batchId!: string | null;

  @ManyToOne(() => AnchorBatch, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'batch_id' })
  batch?: AnchorBatch | null;

  @ApiPropertyOptional()
  @Column({ name: 'leaf_index', type: 'int', nullable: true })
  leafIndex!: number | null;

  @ApiPropertyOptional({ type: [String] })
  @Column({ name: 'merkle_proof', type: 'jsonb', nullable: true })
  merkleProof!: string[] | null;

  @ApiProperty()
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
