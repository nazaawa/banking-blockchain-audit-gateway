import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { maskIban } from '../../common/utils/masking.util';
import type { Transaction } from '../entities/transaction.entity';
import { TransactionStatus } from '../enums/transaction-status.enum';

/** Detail de l'echange SOAP associe a la transaction. */
export class SoapExchangeSummaryDto {
  @ApiPropertyOptional({ example: 'NumberToDollars' })
  operation?: string;

  @ApiPropertyOptional({ example: 412, description: 'Duree de l appel externe, en millisecondes' })
  durationMs?: number;

  @ApiPropertyOptional({ example: 1, description: 'Nombre de tentatives consommees' })
  attempts?: number;

  @ApiPropertyOptional({ example: 'soap:Server' })
  faultCode?: string;

  @ApiPropertyOptional({ example: 'Server was unable to process request.' })
  faultString?: string;
}

/**
 * Representation d'une transaction exposee par l'API.
 *
 * Les IBAN sont **volontairement masques** : le stockage conserve la valeur
 * complete (necessaire a l'execution du virement), la surface HTTP ne la
 * restitue jamais.
 */
export class TransferResponseDto {
  @ApiProperty({ example: 'TRF-20260725-8F3A2C71' })
  reference!: string;

  @ApiProperty({ enum: TransactionStatus, example: TransactionStatus.COMPLETED })
  status!: TransactionStatus;

  @ApiProperty({ example: 'FR76****0189', description: 'IBAN du donneur d ordre, masque' })
  debtorIbanMasked!: string;

  @ApiPropertyOptional({ example: 'Societe Kongo SARL' })
  debtorName?: string;

  @ApiProperty({ example: 'DE89****3000', description: 'IBAN du beneficiaire, masque' })
  creditorIbanMasked!: string;

  @ApiProperty({ example: 'ACME GmbH' })
  creditorName!: string;

  @ApiProperty({ example: 1250.75 })
  amount!: number;

  @ApiProperty({ example: 'EUR' })
  currency!: string;

  @ApiPropertyOptional({ example: 'Facture 2026-0042' })
  endToEndLabel?: string;

  @ApiPropertyOptional({
    example: 'one thousand two hundred and fifty dollars and seventy five cents',
    description: 'Montant en toutes lettres, restitue par le service SOAP externe',
  })
  amountInWords?: string;

  @ApiPropertyOptional({
    example: 'Faute SOAP sur l operation NumberToDollars : Server was unable to process request.',
  })
  failureReason?: string;

  @ApiProperty({ type: SoapExchangeSummaryDto })
  soap!: SoapExchangeSummaryDto;

  @ApiProperty({ example: 'b6f0c4a2-6a5f-4a13-9d2e-3f0c9e2a1b77' })
  correlationId!: string;

  @ApiPropertyOptional({ example: '2026-07-25T10:12:33.827Z' })
  processedAt?: string;

  @ApiProperty({ example: '2026-07-25T10:12:33.415Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-07-25T10:12:33.827Z' })
  updatedAt!: string;

  static fromEntity(transaction: Transaction): TransferResponseDto {
    const dto = new TransferResponseDto();

    dto.reference = transaction.reference;
    dto.status = transaction.status;
    dto.debtorIbanMasked = maskIban(transaction.debtorIban);
    dto.debtorName = transaction.debtorName ?? undefined;
    dto.creditorIbanMasked = maskIban(transaction.creditorIban);
    dto.creditorName = transaction.creditorName;
    dto.amount = Number(transaction.amount);
    dto.currency = transaction.currency;
    dto.endToEndLabel = transaction.endToEndLabel ?? undefined;
    dto.amountInWords = transaction.amountInWords ?? undefined;
    dto.failureReason = transaction.failureReason ?? undefined;
    dto.soap = {
      operation: transaction.soapOperation ?? undefined,
      durationMs: transaction.soapDurationMs ?? undefined,
      attempts: transaction.soapAttempts ?? undefined,
      faultCode: transaction.faultCode ?? undefined,
      faultString: transaction.faultString ?? undefined,
    };
    dto.correlationId = transaction.correlationId;
    dto.processedAt = transaction.processedAt?.toISOString();
    dto.createdAt = transaction.createdAt.toISOString();
    dto.updatedAt = transaction.updatedAt.toISOString();

    return dto;
  }
}
