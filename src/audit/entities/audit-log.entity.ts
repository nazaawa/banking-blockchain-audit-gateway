import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { AuditDirection, AuditOutcome } from '../enums/audit-direction.enum';

/**
 * Piste d'audit des echanges SOAP.
 *
 * Les payloads XML y sont stockes **deja masques** (voir `AuditService`) :
 * la table ne contient jamais d'IBAN complet ni de secret.
 */
@Entity('audit_logs')
@Index('idx_audit_logs_correlation_id', ['correlationId'])
@Index('idx_audit_logs_transaction_reference', ['transactionReference'])
@Index('idx_audit_logs_created_at', ['createdAt'])
export class AuditLog {
  @ApiProperty({ format: 'uuid' })
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ApiProperty({ description: 'Identifiant de correlation de la requete HTTP d origine' })
  @Column({ name: 'correlation_id', type: 'varchar', length: 128 })
  correlationId!: string;

  @ApiPropertyOptional({ example: 'TRF-20260725-8F3A2C71' })
  @Column({ name: 'transaction_reference', type: 'varchar', length: 32, nullable: true })
  transactionReference!: string | null;

  @ApiProperty({ enum: AuditDirection })
  @Column({ type: 'enum', enum: AuditDirection })
  direction!: AuditDirection;

  @ApiProperty({ enum: AuditOutcome })
  @Column({ type: 'enum', enum: AuditOutcome })
  outcome!: AuditOutcome;

  @ApiProperty({ example: 'NumberToDollars' })
  @Column({ type: 'varchar', length: 64 })
  operation!: string;

  @ApiPropertyOptional()
  @Column({ type: 'varchar', length: 512, nullable: true })
  endpoint!: string | null;

  @ApiPropertyOptional({
    description: 'XML masque et tronque, ou null si la retention est desactivee',
  })
  @Column({ type: 'text', nullable: true })
  payload!: string | null;

  @ApiPropertyOptional({ description: 'Taille du payload d origine, en octets' })
  @Column({ name: 'payload_bytes', type: 'int', nullable: true })
  payloadBytes!: number | null;

  @ApiPropertyOptional()
  @Column({ name: 'http_status', type: 'int', nullable: true })
  httpStatus!: number | null;

  @ApiPropertyOptional()
  @Column({ name: 'duration_ms', type: 'int', nullable: true })
  durationMs!: number | null;

  @ApiPropertyOptional()
  @Column({ name: 'fault_code', type: 'varchar', length: 128, nullable: true })
  faultCode!: string | null;

  @ApiPropertyOptional()
  @Column({ name: 'fault_string', type: 'varchar', length: 1024, nullable: true })
  faultString!: string | null;

  @ApiPropertyOptional({ description: 'Message technique associe a un echec de communication' })
  @Column({ type: 'varchar', length: 1024, nullable: true })
  message!: string | null;

  @ApiProperty()
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
