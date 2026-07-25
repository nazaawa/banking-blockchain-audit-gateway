import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RefundStatus } from '../../mobile-money/enums/mobile-money.enum';
import { Refund } from '../entities/refund.entity';

/**
 * Vue publique d'un remboursement.
 *
 * La cle d'idempotence fournisseur reste interne : l'exposer permettrait a un
 * tiers de rejouer directement une demande aupres de l'agregateur.
 */
export class RefundResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'TRF-20260725-8F3A2C71' })
  transactionReference!: string;

  @ApiProperty({ enum: RefundStatus })
  status!: RefundStatus;

  @ApiProperty({ example: 1 })
  amount!: number;

  @ApiProperty({ example: 'CDF' })
  currency!: string;

  @ApiPropertyOptional()
  reason?: string;

  @ApiPropertyOptional({ description: 'Reference du remboursement cote fournisseur' })
  providerRefundReference?: string;

  @ApiProperty()
  attempts!: number;

  @ApiPropertyOptional()
  lastError?: string;

  @ApiPropertyOptional()
  requestedAt?: Date;

  @ApiPropertyOptional()
  completedAt?: Date;

  @ApiPropertyOptional()
  createdBy?: string;

  @ApiPropertyOptional()
  lastRequestedBy?: string;

  @ApiPropertyOptional()
  lastApprovedBy?: string;

  @ApiProperty()
  correlationId!: string;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;

  static fromEntity(refund: Refund): RefundResponseDto {
    const dto = new RefundResponseDto();
    dto.id = refund.id;
    dto.transactionReference = refund.transactionReference;
    dto.status = refund.status;
    dto.amount = refund.amount;
    dto.currency = refund.currency;
    dto.reason = refund.reason ?? undefined;
    dto.providerRefundReference = refund.providerRefundReference ?? undefined;
    dto.attempts = refund.attempts;
    dto.lastError = refund.lastError ?? undefined;
    dto.requestedAt = refund.requestedAt ?? undefined;
    dto.completedAt = refund.completedAt ?? undefined;
    dto.createdBy = refund.createdBy ?? undefined;
    dto.lastRequestedBy = refund.lastRequestedBy ?? undefined;
    dto.lastApprovedBy = refund.lastApprovedBy ?? undefined;
    dto.correlationId = refund.correlationId;
    dto.createdAt = refund.createdAt;
    dto.updatedAt = refund.updatedAt;
    return dto;
  }
}
