import { Controller, Get, Param } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
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
  @ApiOperation({
    summary: 'Verifier l integrite de la chaine d evenements',
    description: [
      'Eprouve trois proprietes independantes :',
      '- **contenu** : chaque document reconstruit redonne son empreinte scellee ;',
      '- **ordre** : chaque maillon pointe vers l empreinte du precedent, et les',
      '  rangs forment une suite continue ;',
      '- **publication** : la preuve d inclusion mene a une racine publiee.',
      '',
      'Verdicts : `VERIFIED`, `PARTIALLY_ANCHORED`, `TAMPERED`, `EMPTY`,',
      '`CHAIN_UNAVAILABLE`.',
    ].join('\n'),
  })
  @ApiOkResponse({ description: 'Rapport de controle maillon par maillon' })
  @ApiNotFoundResponse({ description: 'Reference inconnue', type: ErrorResponseDto })
  async verifyChain(@Param() params: TransferParamsDto): Promise<EventChainReport> {
    return this.verification.verify(params.reference);
  }
}
