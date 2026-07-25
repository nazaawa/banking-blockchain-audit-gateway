import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireScopes } from '../auth/decorators/scopes.decorator';
import { SCOPES } from '../auth/scopes';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { AnchorService } from './anchor.service';
import { AnchorBatch } from './entities/anchor-batch.entity';

@ApiTags('anchors')
@Controller('anchors')
export class AnchorsController {
  constructor(private readonly anchorService: AnchorService) {}

  @Get('batches')
  @RequireScopes(SCOPES.anchorsRead)
  @ApiOperation({
    summary: 'Lister les lots d ancrage',
    description:
      'Du plus recent au plus ancien, avec leur racine de Merkle et leur transaction blockchain.',
  })
  @ApiOkResponse({ type: [AnchorBatch] })
  async listBatches(@Query('limit') limit?: string): Promise<AnchorBatch[]> {
    const parsed = Number.parseInt(limit ?? '20', 10);
    return this.anchorService.listBatches(Number.isFinite(parsed) ? Math.min(parsed, 100) : 20);
  }

  @Get('batches/:id')
  @RequireScopes(SCOPES.anchorsRead)
  @ApiOperation({ summary: 'Consulter un lot d ancrage' })
  @ApiOkResponse({ type: AnchorBatch })
  @ApiNotFoundResponse({ description: 'Lot inconnu', type: ErrorResponseDto })
  async findBatch(@Param('id', ParseUUIDPipe) id: string): Promise<AnchorBatch> {
    const batch = await this.anchorService.findBatch(id);
    if (!batch) {
      throw new NotFoundException({
        error: 'BATCH_NOT_FOUND',
        message: `Aucun lot d ancrage pour l identifiant ${id}`,
      });
    }
    return batch;
  }

  @Post('batches')
  @RequireScopes(SCOPES.anchorsWrite)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Declencher un ancrage immediat',
    description:
      'Constitue un lot avec les transactions scellees en attente et publie sa racine sans ' +
      'attendre la prochaine echeance du planificateur. Destine a l exploitation et a la ' +
      'demonstration ; le fonctionnement nominal reste periodique.',
  })
  @ApiOkResponse({
    description:
      'Resultat de la tentative. `anchored: 0` avec `reason: NOTHING_TO_ANCHOR` si la file est vide.',
  })
  async anchorNow(): Promise<{ anchored: number; batchId: string | null; reason?: string }> {
    const outcome = await this.anchorService.processPendingBatch();
    return {
      anchored: outcome.anchored,
      batchId: outcome.batch?.id ?? null,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    };
  }

  @Get('statistics')
  @RequireScopes(SCOPES.anchorsRead)
  @ApiOperation({ summary: 'Repartition des transactions par etat d ancrage' })
  @ApiOkResponse({ description: 'Nombre de transactions par statut' })
  async statistics(): Promise<Record<string, number>> {
    return this.anchorService.getStatistics();
  }
}
