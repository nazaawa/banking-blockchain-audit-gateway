import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, Matches } from 'class-validator';
import { IsMonetaryAmount } from '../../common/validators/is-monetary-amount.validator';
import { MobileMoneyWebhookStatus } from './mobile-money-webhook.dto';

/** Parametres permettant de simuler aussi les ecarts et rejets operateur. */
export class SimulateMobileMoneyDto {
  @ApiPropertyOptional({
    enum: MobileMoneyWebhookStatus,
    default: MobileMoneyWebhookStatus.CONFIRMED,
  })
  @IsOptional()
  @IsEnum(MobileMoneyWebhookStatus)
  status?: MobileMoneyWebhookStatus;

  @ApiPropertyOptional({
    description: 'Montant confirme; omis, le simulateur reprend le montant demande',
    type: Number,
  })
  @IsOptional()
  @IsMonetaryAmount({ maxDecimals: 2, min: 0.01 })
  amount?: number;

  @ApiPropertyOptional({
    description: 'Devise confirmee; omise, le simulateur reprend la devise demandee',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(/^[A-Z]{3}$/)
  currency?: string;
}
