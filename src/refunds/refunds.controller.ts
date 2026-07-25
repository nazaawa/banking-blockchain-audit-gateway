import { Controller, Get, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { RequireScopes } from '../auth/decorators/scopes.decorator';
import { SCOPES } from '../auth/scopes';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { TransferParamsDto } from '../transactions/dto/transfer-params.dto';
import { RefundResponseDto } from './dto/refund-response.dto';
import { RefundsService } from './refunds.service';

@ApiTags('refunds')
@Controller('transfers/:reference/refund')
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Post()
  @RequireScopes(SCOPES.refundsWrite)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Demander le remboursement du payeur',
    description: [
      'Restitue le montant **effectivement encaisse** par le fournisseur — non le',
      'montant commande : sur un ecart, rembourser la commande enrichirait le payeur.',
      '',
      'Idempotent : un second appel sur un dossier abouti renvoie l existant sans',
      'solliciter le fournisseur. Une tentative en echec est rejouable, la cle',
      'transmise au fournisseur garantissant qu il ne remboursera pas deux fois.',
      '',
      'Habilitation `refunds:write` requise : ce point d entree fait sortir des fonds.',
    ].join('\n'),
  })
  @ApiOkResponse({ type: RefundResponseDto })
  @ApiNotFoundResponse({ description: 'Reference inconnue', type: ErrorResponseDto })
  @ApiUnprocessableEntityResponse({
    description: 'Aucune dette envers le payeur, ou montant encaisse inconnu',
    type: ErrorResponseDto,
  })
  async request(
    @Param() params: TransferParamsDto,
    @Req() req: Request,
  ): Promise<RefundResponseDto> {
    return RefundResponseDto.fromEntity(
      await this.refunds.requestRefund(params.reference, req.apiKey?.keyId),
    );
  }

  @Get()
  @RequireScopes(SCOPES.transfersRead)
  @ApiOperation({ summary: 'Consulter le statut d un remboursement' })
  @ApiOkResponse({ type: RefundResponseDto })
  @ApiNotFoundResponse({ description: 'Aucun remboursement ouvert', type: ErrorResponseDto })
  async findOne(@Param() params: TransferParamsDto): Promise<RefundResponseDto> {
    return RefundResponseDto.fromEntity(await this.refunds.findByTransaction(params.reference));
  }
}
