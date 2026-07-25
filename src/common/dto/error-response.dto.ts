import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Enveloppe d'erreur unique retournee par l'ensemble de l'API. */
export class ErrorResponseDto {
  @ApiProperty({ example: 400 })
  statusCode!: number;

  @ApiProperty({
    example: 'VALIDATION_ERROR',
    description: 'Code d erreur stable, exploitable par le client',
  })
  error!: string;

  @ApiProperty({
    example: [
      'creditorIban doit etre un IBAN valide (structure ISO 13616 et cle de controle MOD 97-10)',
    ],
    description: 'Message unique ou liste de messages de validation',
    type: [String],
  })
  message!: string | string[];

  @ApiProperty({ example: 'b6f0c4a2-6a5f-4a13-9d2e-3f0c9e2a1b77' })
  correlationId!: string;

  @ApiProperty({ example: '2026-07-25T10:12:33.415Z' })
  timestamp!: string;

  @ApiProperty({ example: '/api/v1/transfers' })
  path!: string;

  @ApiPropertyOptional({
    description:
      'Reference du virement lorsque la transaction a pu etre enregistree malgre l erreur',
    example: 'TRF-20260725-8F3A2C71',
  })
  reference?: string;

  @ApiPropertyOptional({
    description: 'Details techniques de la faute SOAP, le cas echeant',
    example: { faultCode: 'soap:Server', faultString: 'Server was unable to process request.' },
  })
  details?: Record<string, unknown>;
}
