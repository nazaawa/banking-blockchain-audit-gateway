import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { IsIban, normalizeIban } from '../../common/validators/is-iban.validator';
import { IsMonetaryAmount } from '../../common/validators/is-monetary-amount.validator';

/** Normalise un IBAN saisi avec espaces ou en minuscules avant validation. */
const NormalizeIban = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizeIban(value) : value,
  );

const Trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

/**
 * Jeu de caracteres admis pour un libelle de virement (aligne sur le jeu
 * « SEPA basic latin ») : rejette les caracteres de controle et les scripts
 * susceptibles d'etre reinjectes dans un flux XML ou un fichier de remise.
 */
const SEPA_LABEL = /^[A-Za-z0-9/\-?:().,'+ ]+$/;

/** Demande d'initiation de virement. */
export class CreateTransferDto {
  @ApiProperty({
    description: 'IBAN du donneur d ordre (espaces et minuscules acceptes, normalises)',
    example: 'FR7630006000011234567890189',
    maxLength: 34,
  })
  @NormalizeIban()
  @IsIban()
  debtorIban!: string;

  @ApiPropertyOptional({
    description: 'Nom du donneur d ordre',
    example: 'Societe Kongo SARL',
    maxLength: 140,
  })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 140)
  @Matches(SEPA_LABEL, { message: 'debtorName contient des caracteres non autorises' })
  debtorName?: string;

  @ApiProperty({
    description: 'IBAN du beneficiaire',
    example: 'DE89370400440532013000',
    maxLength: 34,
  })
  @NormalizeIban()
  @IsIban()
  creditorIban!: string;

  @ApiProperty({
    description: 'Nom du beneficiaire',
    example: 'ACME GmbH',
    maxLength: 140,
  })
  @Trim()
  @IsString()
  @Length(1, 140)
  @Matches(SEPA_LABEL, { message: 'creditorName contient des caracteres non autorises' })
  creditorName!: string;

  @ApiProperty({
    description: 'Montant du virement, strictement positif, 2 decimales maximum',
    example: 1250.75,
    type: Number,
  })
  @IsMonetaryAmount({ maxDecimals: 2, min: 0.01 })
  amount!: number;

  @ApiProperty({
    description: 'Devise ISO 4217 (doit figurer dans ALLOWED_CURRENCIES)',
    example: 'EUR',
    minLength: 3,
    maxLength: 3,
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency doit etre un code ISO 4217 de 3 lettres majuscules' })
  currency!: string;

  @ApiPropertyOptional({
    description: 'Libelle communique au beneficiaire',
    example: 'Facture 2026-0042',
    maxLength: 140,
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(140)
  @Matches(SEPA_LABEL, { message: 'endToEndLabel contient des caracteres non autorises' })
  endToEndLabel?: string;
}
