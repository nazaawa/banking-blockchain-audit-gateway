import { ApiProperty } from '@nestjs/swagger';
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

export enum BankInstructionStatus {
  /** En file, prete a partir. */
  PENDING = 'PENDING',
  /** Reclamee par un travailleur, appel en cours. */
  IN_FLIGHT = 'IN_FLIGHT',
  COMPLETED = 'COMPLETED',
  /** Epuisee apres N tentatives : demande une decision humaine. */
  DEAD_LETTER = 'DEAD_LETTER',
}

/**
 * Instruction bancaire en attente d'execution.
 *
 * ## Pourquoi cette file existe
 *
 * L'appel au back-office se faisait dans le traitement du webhook : l'agregateur
 * attendait notre reponse SOAP. Un back-office lent le faisait expirer, il
 * rejouait, et sa relivraison retombait sur une jambe bancaire deja reclamee —
 * la confirmation etait acquittee alors que l'appel se perdait en vol.
 *
 * Le webhook accuse desormais reception et rend la main. Un travailleur draine
 * la file a son rythme.
 *
 * ## Pourquoi pas de courtier
 *
 * La file vit dans PostgreSQL, comme les autres reprises du systeme. Un courtier
 * ajouterait une infrastructure a exploiter et un second endroit ou une donnee
 * peut se perdre — alors que la garantie recherchee, l'atomicite entre l'etat
 * metier et sa mise en file, s'obtient ici gratuitement : les deux ecritures
 * partagent la meme transaction SQL.
 */
@Entity('bank_instructions')
@Index('idx_bank_instructions_claimable', ['status', 'nextAttemptAt'])
export class BankInstruction {
  @ApiProperty({ format: 'uuid' })
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Une seule instruction par transaction.
   *
   * L'unicite fait de la mise en file une operation idempotente : une seconde
   * notification ne peut pas produire un second appel bancaire, quelle que soit
   * la course qui l'a provoquee.
   */
  @ApiProperty({ example: 'TRF-20260726-8F3A2C71' })
  @Column({ name: 'transaction_reference', type: 'varchar', length: 32, unique: true })
  transactionReference!: string;

  @ManyToOne(() => Transaction, { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn({
    name: 'transaction_reference',
    referencedColumnName: 'reference',
    foreignKeyConstraintName: 'FK_bank_instructions_transaction',
  })
  transaction?: Transaction;

  @ApiProperty({ enum: BankInstructionStatus })
  @Column({
    type: 'enum',
    enum: BankInstructionStatus,
    default: BankInstructionStatus.PENDING,
  })
  status!: BankInstructionStatus;

  @ApiProperty({ example: 0 })
  @Column({ type: 'int', default: 0 })
  attempts!: number;

  /**
   * Date a partir de laquelle une nouvelle tentative est permise.
   *
   * Porte le recul exponentiel. Rejouer immediatement un back-office en
   * difficulte le maintiendrait en difficulte.
   */
  @ApiProperty()
  @Column({ name: 'next_attempt_at', type: 'timestamptz', default: () => 'now()' })
  nextAttemptAt!: Date;

  @ApiProperty({ nullable: true })
  @Column({ name: 'last_error', type: 'varchar', length: 1024, nullable: true })
  lastError!: string | null;

  /** Vrai tant que l'echec constate peut relever d'un incident passager. */
  @ApiProperty()
  @Column({ type: 'boolean', default: true })
  retryable!: boolean;

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
