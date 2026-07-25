import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiGatewayTimeoutResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { RequireScopes } from '../auth/decorators/scopes.decorator';
import { SCOPES } from '../auth/scopes';
import { AuditLog } from '../audit/entities/audit-log.entity';
import type { EventChainReport } from '../events/event-chain-verification.service';
import { EventChainVerificationService } from '../events/event-chain-verification.service';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { CreateTransferDto } from './dto/create-transfer.dto';
import { PaginatedTransfersDto, QueryTransfersDto } from './dto/query-transfers.dto';
import { TransferParamsDto } from './dto/transfer-params.dto';
import { TransferResponseDto } from './dto/transfer-response.dto';
import { TransactionsService } from './transactions.service';

@ApiTags('transfers')
@Controller('transfers')
export class TransactionsController {
  constructor(
    private readonly transactionsService: TransactionsService,
    private readonly verificationService: EventChainVerificationService,
  ) {}

  @Post()
  @RequireScopes(SCOPES.transfersWrite)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Initier un virement',
    description: [
      'Valide la demande, genere une reference unique, appelle le service SOAP',
      'externe pour obtenir le montant en toutes lettres, puis enregistre la',
      'transaction en base.',
      '',
      'La transaction est persistee **avant** l appel externe : en cas d echec',
      '(502 / 504), la reference retournee dans le corps d erreur reste',
      'consultable via `GET /transfers/{reference}` avec le statut `FAILED`.',
    ].join('\n'),
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Cle d idempotence. Un rejeu avec la meme cle renvoie la transaction initiale ' +
      'sans nouvel appel au service externe.',
  })
  @ApiHeader({
    name: 'X-Correlation-Id',
    required: false,
    description: 'Identifiant de correlation propage dans les logs et la piste d audit.',
  })
  @ApiCreatedResponse({ description: 'Virement enregistre et enrichi', type: TransferResponseDto })
  @ApiBadRequestResponse({
    description: 'Donnees invalides (IBAN, montant, devise)',
    type: ErrorResponseDto,
  })
  @ApiUnprocessableEntityResponse({
    description: 'Regle metier non respectee',
    type: ErrorResponseDto,
  })
  @ApiBadGatewayResponse({
    description: 'Faute SOAP ou service externe injoignable',
    type: ErrorResponseDto,
  })
  @ApiGatewayTimeoutResponse({
    description: 'Delai d attente du service externe depasse',
    type: ErrorResponseDto,
  })
  async create(
    @Body() dto: CreateTransferDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<TransferResponseDto> {
    const transaction = await this.transactionsService.initiateTransfer(
      dto,
      idempotencyKey?.trim() || undefined,
    );
    return TransferResponseDto.fromEntity(transaction);
  }

  @Get()
  @RequireScopes(SCOPES.transfersRead)
  @ApiOperation({
    summary: 'Lister les virements',
    description: 'Liste paginee, du plus recent au plus ancien.',
  })
  @ApiOkResponse({ type: PaginatedTransfersDto })
  async findAll(@Query() query: QueryTransfersDto): Promise<PaginatedTransfersDto> {
    return this.transactionsService.list(query);
  }

  @Get(':reference')
  @RequireScopes(SCOPES.transfersRead)
  @ApiOperation({ summary: 'Consulter le statut d un virement' })
  @ApiOkResponse({ type: TransferResponseDto })
  @ApiNotFoundResponse({ description: 'Reference inconnue', type: ErrorResponseDto })
  async findOne(@Param() params: TransferParamsDto): Promise<TransferResponseDto> {
    const transaction = await this.transactionsService.findByReference(params.reference);
    return TransferResponseDto.fromEntity(transaction);
  }

  @Get(':reference/verification')
  @RequireScopes(SCOPES.transfersRead)
  @ApiOperation({
    summary: 'Verifier l integrite d un virement',
    description: [
      'Le registre append-only remplace le scellement d instantane : la preuve ne',
      'porte plus sur un etat courant mais sur la suite des faits.',
      '',
      'Quatre proprietes independantes sont eprouvees :',
      '- **contenu** : chaque document reconstruit redonne son empreinte scellee ;',
      '- **ordre** : chaque maillon pointe vers le precedent, rangs continus ;',
      '- **exhaustivite** : la cloture declare le total, fermant la troncature de queue ;',
      '- **coherence** : la ligne `transactions` correspond encore a ce que',
      '  l ouverture a consigne — c est ce controle qui detecte un IBAN modifie.',
      '',
      'Verdicts : `VERIFIED`, `PARTIALLY_ANCHORED`, `TAMPERED`, `EMPTY`,',
      '`CHAIN_UNAVAILABLE`.',
    ].join('\n'),
  })
  @ApiOkResponse({ description: 'Rapport de controle maillon par maillon' })
  @ApiNotFoundResponse({ description: 'Reference inconnue', type: ErrorResponseDto })
  async verifyIntegrity(@Param() params: TransferParamsDto): Promise<EventChainReport> {
    await this.transactionsService.findByReference(params.reference);
    return this.verificationService.verify(params.reference);
  }

  @Get(':reference/audit')
  @RequireScopes(SCOPES.transfersRead)
  @ApiOperation({
    summary: 'Consulter la piste d audit d un virement',
    description:
      'Retourne les echanges SOAP consignes. Les payloads XML y sont masques : ' +
      'aucun IBAN complet n est restitue.',
  })
  @ApiOkResponse({ type: [AuditLog] })
  @ApiNotFoundResponse({ description: 'Reference inconnue', type: ErrorResponseDto })
  async findAuditTrail(@Param() params: TransferParamsDto): Promise<AuditLog[]> {
    return this.transactionsService.getAuditTrail(params.reference);
  }
}
