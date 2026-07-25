import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsISO8601, IsOptional, IsString, Length, Matches } from 'class-validator';
import { IsMonetaryAmount } from '../../common/validators/is-monetary-amount.validator';
import { ProviderStatus } from '../enums/mobile-money.enum';

export enum MobileMoneyWebhookStatus {
  CONFIRMED = ProviderStatus.CONFIRMED,
  FAILED = ProviderStatus.FAILED,
}

/** Notification signee emise par l'agregateur (ou par son simulateur local). */
export class MobileMoneyWebhookDto {
  @ApiProperty({ example: 'EVT-20260725-A1B2C3D4' })
  @IsString()
  @Length(1, 128)
  eventId!: string;

  @ApiProperty({ example: 'AGG-20260725-A1B2C3D4' })
  @IsString()
  @Length(1, 64)
  aggregatorReference!: string;

  @ApiProperty({ enum: MobileMoneyWebhookStatus })
  @IsEnum(MobileMoneyWebhookStatus)
  status!: MobileMoneyWebhookStatus;

  @ApiProperty({ example: 1250.75, type: Number })
  @IsMonetaryAmount({ maxDecimals: 2, min: 0.01 })
  amount!: number;

  @ApiProperty({ example: 'CDF' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(/^[A-Z]{3}$/)
  currency!: string;

  @ApiProperty({ example: '2026-07-25T10:12:33.827Z' })
  @IsISO8601({ strict: true })
  occurredAt!: string;

  @ApiPropertyOptional({ description: 'Motif fourni par l operateur en cas d echec' })
  @IsOptional()
  @IsString()
  @Length(1, 512)
  failureReason?: string;
}
