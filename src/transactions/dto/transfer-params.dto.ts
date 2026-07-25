import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { Matches } from 'class-validator';
import { REFERENCE_PATTERN } from '../reference.generator';

/** Parametre de chemin : reference fonctionnelle du virement. */
export class TransferParamsDto {
  @ApiProperty({ example: 'TRF-20260725-8F3A2C71', pattern: REFERENCE_PATTERN.source })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(REFERENCE_PATTERN, {
    message: 'reference doit respecter le format TRF-YYYYMMDD-XXXXXXXX',
  })
  reference!: string;
}
