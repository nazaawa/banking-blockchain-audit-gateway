import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { TransactionStatus } from '../enums/transaction-status.enum';
import { TransferResponseDto } from './transfer-response.dto';

/** Criteres de recherche et pagination des virements. */
export class QueryTransfersDto {
  @ApiPropertyOptional({ enum: TransactionStatus, description: 'Filtre sur le statut' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsEnum(TransactionStatus, {
    message: `status doit valoir l'une de [${Object.values(TransactionStatus).join(', ')}]`,
  })
  status?: TransactionStatus;

  @ApiPropertyOptional({ example: 'EUR', description: 'Filtre sur la devise ISO 4217' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(/^[A-Z]{3}$/, { message: 'currency doit etre un code ISO 4217 de 3 lettres majuscules' })
  currency?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}

/** Enveloppe de pagination. */
export class PaginatedTransfersDto {
  @ApiProperty({ type: [TransferResponseDto] })
  items!: TransferResponseDto[];

  @ApiProperty({ example: 137 })
  total!: number;

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 7 })
  pages!: number;
}
