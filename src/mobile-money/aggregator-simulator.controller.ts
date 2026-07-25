import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { mobileMoneyConfig } from '../config/configuration';
import { AggregatorSimulatorService } from './aggregator-simulator.service';
import { MobileMoneyResponseDto } from './dto/mobile-money-response.dto';
import { SimulateMobileMoneyDto } from './dto/simulate-mobile-money.dto';
import { MobileMoneyService } from './mobile-money.service';
import { MobileMoneyWebhookService } from './mobile-money-webhook.service';

/** Surface de demonstration remplacable par un vrai agregateur. */
@ApiTags('mobile-money-simulator')
@Controller('simulator/mobile-money')
export class AggregatorSimulatorController {
  constructor(
    private readonly simulator: AggregatorSimulatorService,
    private readonly mobileMoney: MobileMoneyService,
    private readonly webhooks: MobileMoneyWebhookService,
    @Inject(mobileMoneyConfig.KEY)
    private readonly config: ConfigType<typeof mobileMoneyConfig>,
  ) {}

  @Get('payments/:aggregatorReference')
  @ApiOperation({ summary: 'Consulter un paiement dans le simulateur' })
  @ApiOkResponse({ type: MobileMoneyResponseDto })
  async findOne(
    @Param('aggregatorReference') aggregatorReference: string,
  ): Promise<MobileMoneyResponseDto> {
    this.assertEnabled();
    return MobileMoneyResponseDto.fromEntity(
      await this.mobileMoney.findByAggregatorReference(aggregatorReference),
    );
  }

  @Post('payments/:aggregatorReference/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Simuler un callback operateur',
    description:
      'Construit et signe un vrai webhook interne. Un montant ou une devise differente permet de tester un ecart de rapprochement.',
  })
  @ApiOkResponse({ type: MobileMoneyResponseDto })
  async confirm(
    @Param('aggregatorReference') aggregatorReference: string,
    @Body() input: SimulateMobileMoneyDto,
  ): Promise<MobileMoneyResponseDto> {
    this.assertEnabled();
    const transaction = await this.mobileMoney.findByAggregatorReference(aggregatorReference);
    const payload = this.simulator.buildWebhook(transaction, input);
    const signature = this.webhooks.sign(payload);
    return MobileMoneyResponseDto.fromEntity(await this.webhooks.handle(payload, signature));
  }

  private assertEnabled(): void {
    if (!this.config.simulatorEnabled) {
      throw new NotFoundException({
        error: 'SIMULATOR_DISABLED',
        message: 'Le simulateur Mobile Money est desactive',
      });
    }
  }
}
