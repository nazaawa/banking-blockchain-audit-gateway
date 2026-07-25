import { ApiProperty } from '@nestjs/swagger';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { TransactionEvent } from '../../events/entities/transaction-event.entity';
import { JournalLine } from './journal-line.entity';

/**
 * Ecriture comptable : un fait, plusieurs lignes, une somme nulle.
 *
 * ## Pourquoi elle est liee a un evenement
 *
 * Chaque ecriture derive d'un fait deja consigne et scelle. Le lien est unique
 * dans les deux sens : un fait ne peut pas produire deux ecritures, et une
 * ecriture ne peut pas naitre sans fait. C'est ce qui rend la comptabilite
 * opposable — elle ne dit rien que le registre n'atteste deja.
 *
 * ## Immuabilite
 *
 * Comme le registre, la table est append-only : une erreur se corrige par une
 * contre-passation, jamais par une reecriture. Un declencheur l'impose, et un
 * second verifie que chaque ecriture est equilibree.
 */
@Entity('journal_entries')
@Unique('uq_journal_entries_event', ['eventId'])
@Index('idx_journal_entries_reference', ['transactionReference'])
export class JournalEntry {
  @ApiProperty()
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ApiProperty({ example: 'TRF-20260725-8F3A2C71' })
  @Column({ name: 'transaction_reference', type: 'varchar', length: 32 })
  transactionReference!: string;

  /**
   * Fait dont l'ecriture est la consequence comptable.
   *
   * L'unicite garantit l'idempotence de la comptabilisation : rejouer la pose
   * d'un fait deja comptabilise est refuse par la base, pas par une convention.
   */
  @ApiProperty()
  @Column({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  @ManyToOne(() => TransactionEvent, { onDelete: 'RESTRICT', nullable: false })
  // Nom impose plutot que genere : la migration et l'entite doivent nommer la
  // meme contrainte, faute de quoi `synchronize` la recreerait a chaque
  // demarrage — defaut deja rencontre sur ce projet.
  @JoinColumn({ name: 'event_id', foreignKeyConstraintName: 'FK_journal_entries_event' })
  event?: TransactionEvent;

  @ApiProperty({ example: 'PROVIDER_CONFIRMED' })
  @Column({ name: 'event_type', type: 'varchar', length: 48 })
  eventType!: string;

  @ApiProperty({ example: 'Encaissement fournisseur' })
  @Column({ type: 'varchar', length: 256 })
  narration!: string;

  @ApiProperty({ example: 'CDF' })
  @Column({ type: 'char', length: 3 })
  currency!: string;

  @ApiProperty({ type: () => [JournalLine] })
  @OneToMany(() => JournalLine, (line) => line.entry, { cascade: ['insert'], eager: true })
  lines!: JournalLine[];

  @ApiProperty()
  @Column({ name: 'correlation_id', type: 'varchar', length: 128 })
  correlationId!: string;

  @ApiProperty()
  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;

  @ApiProperty()
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
