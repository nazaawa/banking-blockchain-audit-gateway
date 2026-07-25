import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RequireScopes } from '../auth/decorators/scopes.decorator';
import { SCOPES } from '../auth/scopes';
import { TransferParamsDto } from '../transactions/dto/transfer-params.dto';
import { JournalEntry } from './entities/journal-entry.entity';
import { LedgerPostingService, type TrialBalance } from './ledger-posting.service';

@ApiTags('ledger')
@Controller('ledger')
export class LedgerController {
  constructor(private readonly ledger: LedgerPostingService) {}

  @Get('balance')
  @RequireScopes(SCOPES.ledgerRead)
  @ApiOperation({
    summary: 'Balance des comptes',
    description:
      'Soldes par compte, exprimes dans le sens ou chacun augmente. ' +
      '`difference` doit toujours valoir zero : une valeur non nulle signale ' +
      'une corruption du journal, pas une erreur de saisie.',
  })
  @ApiQuery({
    name: 'reference',
    required: false,
    description: 'Restreint la balance a une transaction',
  })
  @ApiQuery({
    name: 'currency',
    required: false,
    description: 'Devise requise lorsque la balance globale en contient plusieurs',
  })
  async balance(
    @Query('reference') reference?: string,
    @Query('currency') currency?: string,
  ): Promise<TrialBalance> {
    return this.ledger.trialBalance(reference, currency);
  }

  @Get('transfers/:reference/entries')
  @RequireScopes(SCOPES.ledgerRead)
  @ApiOperation({
    summary: 'Ecritures comptables d une transaction',
    description:
      'Chaque ecriture porte l identifiant du fait dont elle decoule : le ' +
      'journal ne dit rien que le registre n atteste deja.',
  })
  @ApiOkResponse({ type: [JournalEntry] })
  async entries(@Param() params: TransferParamsDto): Promise<JournalEntry[]> {
    return this.ledger.findByTransaction(params.reference);
  }
}
