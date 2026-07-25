import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { IsIban, normalizeIban } from '../../common/validators/is-iban.validator';
import { IsMonetaryAmount } from '../../common/validators/is-monetary-amount.validator';
import { MobileMoneyOperator } from '../enums/mobile-money.enum';

const Trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

/** Demande de collecte Mobile Money suivie d'un credit bancaire. */
export class CreateMobileMoneyTransactionDto {
  @ApiProperty({ enum: MobileMoneyOperator, example: MobileMoneyOperator.MPESA })
  @IsEnum(MobileMoneyOperator)
  operator!: MobileMoneyOperator;

  @ApiProperty({
    description: 'Numero du payeur au format E.164',
    example: '+243812345678',
  })
  @Trim()
  @Matches(/^\+[1-9]\d{7,14}$/, { message: 'payerMsisdn doit etre un numero E.164 valide' })
  payerMsisdn!: string;

  @ApiProperty({ example: 'DE89370400440532013000' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizeIban(value) : value,
  )
  @IsIban()
  creditorIban!: string;

  @ApiProperty({ example: 'ACME GmbH', maxLength: 140 })
  @Trim()
  @IsString()
  @Length(1, 140)
  creditorName!: string;

  @ApiProperty({ example: 1250.75, type: Number })
  @IsMonetaryAmount({ maxDecimals: 2, min: 0.01 })
  amount!: number;

  @ApiProperty({ example: 'CDF' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(/^[A-Z]{3}$/, { message: 'currency doit etre un code ISO 4217' })
  currency!: string;

  @ApiPropertyOptional({
    description: 'Reference libre du marchand',
    example: 'COMMANDE-2026-0042',
    maxLength: 140,
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(140)
  externalReference?: string;
}
