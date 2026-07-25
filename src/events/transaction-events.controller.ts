import { Controller, Get, Param } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireScopes } from '../auth/decorators/scopes.decorator';
import { SCOPES } from '../auth/scopes';
import { TransferParamsDto } from '../transactions/dto/transfer-params.dto';
import { TransactionEventResponseDto } from './dto/transaction-event-response.dto';
import type { EventChainReport } from './event-chain-verification.service';
import { EventChainVerificationService } from './event-chain-verification.service';
import { TransactionEventsService } from './transaction-events.service';

@ApiTags('events')
@Controller('transfers/:reference/events')
export class TransactionEventsController {
  constructor(
    private readonly events: TransactionEventsService,
    private readonly verification: EventChainVerificationService,
  ) {}

  @Get()
  @RequireScopes(SCOPES.transfersRead)
  @ApiOperation({
    summary: 'Consulter le registre des faits',
    description:
      'Chaine append-only des evenements metier, du plus ancien au plus recent. ' +
      'Chaque maillon porte son empreinte et celle du precedent.',
  })
  @ApiOkResponse({ type: [TransactionEventResponseDto] })
  async findChain(@Param() params: TransferParamsDto): Promise<TransactionEventResponseDto[]> {
    const events = await this.events.findChain(params.reference);
    return events.map((event) => TransactionEventResponseDto.fromEntity(event));
  }

  @Get('verification')
  @RequireScopes(SCOPES.transfersRead)
  @ApiOperation({
    summary: 'Verifier l integrite de la chaine d evenements (alias historique)',
    deprecated: true,
    description:
      'Alias de compatibilite. Utiliser desormais GET /transfers/{reference}/verification.',
  })
  @ApiOkResponse({ description: 'Rapport de controle maillon par maillon' })
  async verifyChain(@Param() params: TransferParamsDto): Promise<EventChainReport> {
    return this.verification.verify(params.reference);
  }
}
