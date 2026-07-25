import { ApiProperty } from '@nestjs/swagger';
import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { EntryDirection, LedgerAccount } from '../enums/ledger.enum';
import { JournalEntry } from './journal-entry.entity';

const numericTransformer = {
  to: (value: number): number => value,
  from: (value: string): number => Number.parseFloat(value),
};

/**
 * Ligne d'ecriture : un compte, un sens, un montant.
 *
 * Le montant est toujours **positif**. Un mouvement negatif serait ambigu — il
 * pourrait signifier « credit » ou « annulation » — alors que le couple
 * (compte, sens) dit exactement une chose.
 */
@Check('CHK_journal_lines_amount_positive', `"amount" > 0`)
@Entity('journal_lines')
@Index('idx_journal_lines_account', ['account'])
export class JournalLine {
  @ApiProperty()
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'entry_id', type: 'uuid' })
  entryId!: string;

  @ManyToOne(() => JournalEntry, (entry) => entry.lines, {
    onDelete: 'RESTRICT',
    nullable: false,
  })
  @JoinColumn({ name: 'entry_id', foreignKeyConstraintName: 'FK_journal_lines_entry' })
  entry?: JournalEntry;

  @ApiProperty({ enum: LedgerAccount })
  @Column({ type: 'enum', enum: LedgerAccount })
  account!: LedgerAccount;

  @ApiProperty({ enum: EntryDirection })
  @Column({ type: 'enum', enum: EntryDirection })
  direction!: EntryDirection;

  @ApiProperty({ example: 1250.75 })
  @Column({ type: 'numeric', precision: 18, scale: 2, transformer: numericTransformer })
  amount!: number;
}
