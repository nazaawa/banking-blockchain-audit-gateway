import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { RequireScopes } from '../auth/decorators/scopes.decorator';
import { SCOPES } from '../auth/scopes';
import { TreasuryService, type SweepOutcome } from './treasury.service';

export class SweepRequestDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

@ApiTags('treasury')
@Controller('treasury')
export class TreasuryController {
  constructor(private readonly treasury: TreasuryService) {}

  @Post('sweeps')
  @HttpCode(HttpStatus.OK)
  @RequireScopes(SCOPES.treasuryWrite)
  @ApiOperation({
    summary: 'Rapatrier les encaissements vers le compte de reglement',
    description:
      'Operation d exploitation : l agregateur ne notifie pas ses reversements. ' +
      'Idempotente — l eligibilite se lit dans le registre, une transaction deja ' +
      'rapatriee est ecartee.',
  })
  async sweep(@Body() dto: SweepRequestDto): Promise<SweepOutcome> {
    return this.treasury.sweep(dto.limit);
  }
}
