import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CreateMobileMoneyTransactionDto } from './dto/create-mobile-money-transaction.dto';
import { MobileMoneyResponseDto } from './dto/mobile-money-response.dto';
import { MobileMoneyService } from './mobile-money.service';
import { ReconciliationService } from './reconciliation.service';

@ApiTags('mobile-money')
@Controller('mobile-money')
export class MobileMoneyController {
  constructor(
    private readonly service: MobileMoneyService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  @Post('transactions')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Initier une transaction Mobile Money',
    description:
      'Enregistre la collecte chez l agregateur. Aucun appel SOAP ni ancrage n est effectue avant le webhook de confirmation.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: MobileMoneyResponseDto })
  async initiate(
    @Body() dto: CreateMobileMoneyTransactionDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<MobileMoneyResponseDto> {
    return MobileMoneyResponseDto.fromEntity(
      await this.service.initiate(dto, idempotencyKey?.trim() || undefined),
    );
  }

  @Get('transactions/:reference')
  @ApiOperation({ summary: 'Consulter le cycle complet d une transaction Mobile Money' })
  @ApiOkResponse({ type: MobileMoneyResponseDto })
  async findOne(@Param('reference') reference: string): Promise<MobileMoneyResponseDto> {
    return MobileMoneyResponseDto.fromEntity(await this.service.findByReference(reference));
  }

  @Post('reconciliation/run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Relancer le moteur de rapprochement sur les paiements eligibles' })
  async runReconciliation(): Promise<{
    examined: number;
    matched: number;
    mismatched: number;
  }> {
    return this.reconciliation.runPending();
  }
}
