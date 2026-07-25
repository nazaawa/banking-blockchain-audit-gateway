import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { maskIban, maskPartial } from '../../common/utils/masking.util';
import { AnchorStatus } from '../../blockchain/enums/anchor-status.enum';
import type { Transaction } from '../../transactions/entities/transaction.entity';
import { TransactionStatus } from '../../transactions/enums/transaction-status.enum';
import {
  BankProcessingStatus,
  MobileMoneyOperator,
  ProviderStatus,
  ReconciliationStatus,
  RefundStatus,
  CaseStatus,
} from '../enums/mobile-money.enum';

/** Vue API du cycle complet Mobile Money -> banque -> rapprochement. */
export class MobileMoneyResponseDto {
  @ApiProperty()
  reference!: string;

  @ApiProperty()
  aggregatorReference!: string;

  @ApiProperty({ enum: TransactionStatus })
  status!: TransactionStatus;

  @ApiProperty({ enum: MobileMoneyOperator })
  operator!: MobileMoneyOperator;

  @ApiProperty({ example: '+24****78' })
  payerMsisdnMasked!: string;

  @ApiProperty({ enum: ProviderStatus })
  providerStatus!: ProviderStatus;

  @ApiProperty({ enum: BankProcessingStatus })
  bankStatus!: BankProcessingStatus;

  @ApiProperty({ enum: ReconciliationStatus })
  reconciliationStatus!: ReconciliationStatus;

  @ApiProperty({
    enum: RefundStatus,
    description: 'Obligation de remboursement envers le payeur',
  })
  refundStatus!: RefundStatus;

  @ApiProperty({ enum: CaseStatus, description: 'Suivi de l action humaine requise' })
  caseStatus!: CaseStatus;

  @ApiPropertyOptional({ description: 'Motif d ouverture du dossier' })
  caseReason?: string;

  @ApiProperty({ example: 'DE89****3000' })
  creditorIbanMasked!: string;

  @ApiProperty()
  creditorName!: string;

  @ApiProperty()
  amount!: number;

  @ApiProperty()
  currency!: string;

  @ApiPropertyOptional()
  amountInWords?: string;

  @ApiPropertyOptional()
  reconciliationReason?: string;

  @ApiPropertyOptional()
  failureReason?: string;

  @ApiProperty()
  anchored!: boolean;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;

  static fromEntity(transaction: Transaction): MobileMoneyResponseDto {
    const dto = new MobileMoneyResponseDto();
    dto.reference = transaction.reference;
    dto.aggregatorReference = transaction.aggregatorReference as string;
    dto.status = transaction.status;
    dto.operator = transaction.mobileMoneyOperator as MobileMoneyOperator;
    dto.payerMsisdnMasked = maskPartial(transaction.payerMsisdn as string, 3, 2);
    dto.providerStatus = transaction.providerStatus as ProviderStatus;
    dto.bankStatus = transaction.bankStatus as BankProcessingStatus;
    dto.reconciliationStatus = transaction.reconciliationStatus as ReconciliationStatus;
    dto.refundStatus = transaction.refundStatus;
    dto.caseStatus = transaction.caseStatus;
    dto.caseReason = transaction.caseReason ?? undefined;
    dto.creditorIbanMasked = maskIban(transaction.creditorIban);
    dto.creditorName = transaction.creditorName;
    dto.amount = Number(transaction.amount);
    dto.currency = transaction.currency;
    dto.amountInWords = transaction.amountInWords ?? undefined;
    dto.reconciliationReason = transaction.reconciliationReason ?? undefined;
    dto.failureReason = transaction.failureReason ?? undefined;
    dto.anchored = transaction.anchorStatus === AnchorStatus.ANCHORED;
    dto.createdAt = transaction.createdAt.toISOString();
    dto.updatedAt = transaction.updatedAt.toISOString();
    return dto;
  }
}
