import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Transaction } from '../../transactions/entities/transaction.entity';
import { RefundStatus } from '../../mobile-money/enums/mobile-money.enum';

const numericTransformer = {
  to: (value: number | null): number | null => value,
  from: (value: string | null): number | null => (value === null ? null : Number.parseFloat(value)),
};

/**
 * Dossier de remboursement d'une transaction.
 *
 * Une seule ligne par transaction : l'etat courant. L'historique des tentatives
 * vit dans le registre append-only, ou il est scelle et ancre — dupliquer ici
 * une chronologie modifiable affaiblirait la preuve plutot que de la completer.
 *
 * Table dediee plutot que colonnes supplementaires sur `transactions` : celle-ci
 * porte deja deux cycles de vie, en ajouter un troisieme aggraverait une dette
 * de structure connue.
 */
@Entity('refunds')
@Index('idx_refunds_status', ['status'])
@Index('idx_refunds_transaction_reference', ['transactionReference'], { unique: true })
export class Refund {
  @ApiProperty({ format: 'uuid' })
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ApiProperty({ example: 'TRF-20260725-8F3A2C71' })
  @Column({ name: 'transaction_reference', type: 'varchar', length: 32 })
  transactionReference!: string;

  @ManyToOne(() => Transaction, { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn({ name: 'transaction_reference', referencedColumnName: 'reference' })
  transaction?: Transaction;

  @ApiProperty({ enum: RefundStatus })
  @Column({ type: 'enum', enum: RefundStatus, default: RefundStatus.REQUIRED })
  status!: RefundStatus;

  /**
   * Montant a restituer : ce que le fournisseur a **effectivement encaisse**,
   * et non ce qui avait ete commande. Sur un ecart, ces deux valeurs different,
   * et rembourser le montant commande creerait un enrichissement du payeur.
   */
  @ApiProperty({ example: 1.0 })
  @Column({ type: 'numeric', precision: 18, scale: 2, transformer: numericTransformer })
  amount!: number;

  @ApiProperty({ example: 'CDF' })
  @Column({ type: 'char', length: 3 })
  currency!: string;

  /** Motif d'ouverture, repris du dossier d'exception. */
  @ApiPropertyOptional()
  @Column({ type: 'varchar', length: 512, nullable: true })
  reason!: string | null;

  /**
   * Cle transmise au fournisseur a chaque tentative.
   *
   * Generee une seule fois : c'est elle qui rend la reprise sure apres un
   * echange interrompu dont l'issue reelle est inconnue.
   */
  @Column({ name: 'provider_idempotency_key', type: 'varchar', length: 64, unique: true })
  providerIdempotencyKey!: string;

  @ApiPropertyOptional({ description: 'Reference du remboursement cote fournisseur' })
  @Column({ name: 'provider_refund_reference', type: 'varchar', length: 64, nullable: true })
  providerRefundReference!: string | null;

  @ApiProperty({ description: 'Tentatives consommees aupres du fournisseur' })
  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @ApiPropertyOptional()
  @Column({ name: 'last_error', type: 'varchar', length: 1024, nullable: true })
  lastError!: string | null;

  /**
   * Un refus metier est terminal tant qu'un operateur ne modifie pas la cause
   * chez le fournisseur. Les pannes de transport, elles, restent rejouables.
   */
  @Column({ type: 'boolean', default: true })
  retryable!: boolean;

  @ApiPropertyOptional()
  @Column({ name: 'requested_at', type: 'timestamptz', nullable: true })
  requestedAt!: Date | null;

  @ApiPropertyOptional()
  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @ApiProperty({ description: 'Acteur ayant cree le dossier' })
  @Column({ name: 'created_by', type: 'varchar', length: 128, nullable: true })
  createdBy!: string | null;

  @ApiPropertyOptional({ description: 'Dernier acteur ayant declenche une tentative manuelle' })
  @Column({ name: 'last_requested_by', type: 'varchar', length: 128, nullable: true })
  lastRequestedBy!: string | null;

  @ApiPropertyOptional({ description: 'Dernier acteur ayant approuve une reouverture' })
  @Column({ name: 'last_approved_by', type: 'varchar', length: 128, nullable: true })
  lastApprovedBy!: string | null;

  @ApiProperty()
  @Column({ name: 'correlation_id', type: 'varchar', length: 128 })
  correlationId!: string;

  @ApiProperty()
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @ApiProperty()
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
