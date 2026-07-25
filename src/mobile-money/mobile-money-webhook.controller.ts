import { Body, Controller, Headers, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { MobileMoneyResponseDto } from './dto/mobile-money-response.dto';
import { MobileMoneyWebhookDto } from './dto/mobile-money-webhook.dto';
import { MobileMoneyWebhookService } from './mobile-money-webhook.service';

@ApiTags('mobile-money-webhooks')
@Controller('webhooks/mobile-money')
export class MobileMoneyWebhookController {
  constructor(private readonly webhooks: MobileMoneyWebhookService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Recevoir une confirmation signee de l agregateur',
    description:
      'La signature porte sur eventId|aggregatorReference|status|amount(2 decimales)|currency|occurredAt|failureReason.',
  })
  @ApiHeader({
    name: 'X-Mobile-Money-Signature',
    required: true,
    description: 'HMAC SHA-256 au format sha256=<hex>',
  })
  @ApiOkResponse({ type: MobileMoneyResponseDto })
  async receive(
    @Body() payload: MobileMoneyWebhookDto,
    @Headers('x-mobile-money-signature') signature = '',
  ): Promise<MobileMoneyResponseDto> {
    return MobileMoneyResponseDto.fromEntity(await this.webhooks.handle(payload, signature));
  }
}
