import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { BatchStatus } from '../enums/anchor-status.enum';

/**
 * Lot de transactions dont la racine de Merkle est inscrite sur la blockchain.
 *
 * Regrouper les transactions rend le cout d'ancrage constant : ancrer 1 ou 1000
 * virements consomme la meme quantite de gaz, puisqu'un seul mot de 32 octets
 * est ecrit. La preuve d'inclusion de chaque virement est reconstituee hors
 * chaine a partir de l'arbre.
 */
@Entity('anchor_batches')
@Index('idx_anchor_batches_status', ['status'])
@Index('idx_anchor_batches_created_at', ['createdAt'])
export class AnchorBatch {
  @ApiProperty({
    format: 'uuid',
    description: 'Identifiant du lot, converti en bytes32 sur la chaine',
  })
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ApiProperty({ enum: BatchStatus })
  @Column({ type: 'enum', enum: BatchStatus, default: BatchStatus.PENDING })
  status!: BatchStatus;

  @ApiProperty({ example: '0x8f3a…', description: 'Racine de Merkle du lot (32 octets)' })
  @Column({ name: 'merkle_root', type: 'varchar', length: 66 })
  merkleRoot!: string;

  @ApiProperty({ example: 42, description: 'Nombre de transactions du lot' })
  @Column({ name: 'leaf_count', type: 'int' })
  leafCount!: number;

  @ApiPropertyOptional({ example: 31337 })
  @Column({ name: 'chain_id', type: 'bigint', nullable: true })
  chainId!: string | null;

  @ApiPropertyOptional({ example: '0x5FbDB2315678afecb367f032d93F642f64180aa3' })
  @Column({ name: 'contract_address', type: 'varchar', length: 42, nullable: true })
  contractAddress!: string | null;

  @ApiPropertyOptional({ description: 'Hash de la transaction blockchain d ancrage' })
  @Column({ name: 'tx_hash', type: 'varchar', length: 66, nullable: true })
  txHash!: string | null;

  @ApiPropertyOptional()
  @Column({ name: 'block_number', type: 'bigint', nullable: true })
  blockNumber!: string | null;

  @ApiPropertyOptional({ description: 'Gaz consomme par l inscription' })
  @Column({ name: 'gas_used', type: 'bigint', nullable: true })
  gasUsed!: string | null;

  @ApiPropertyOptional()
  @Column({ name: 'anchored_at', type: 'timestamptz', nullable: true })
  anchoredAt!: Date | null;

  @ApiProperty({ description: 'Tentatives d ancrage consommees' })
  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @ApiPropertyOptional()
  @Column({ name: 'last_error', type: 'varchar', length: 1024, nullable: true })
  lastError!: string | null;

  @ApiProperty()
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @ApiProperty()
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
