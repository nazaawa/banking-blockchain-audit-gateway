import { Body, Controller, Headers, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { MobileMoneyResponseDto } from './dto/mobile-money-response.dto';
import { MobileMoneyWebhookDto } from './dto/mobile-money-webhook.dto';
import { MobileMoneyWebhookService } from './mobile-money-webhook.service';

@ApiTags('mobile-money-webhooks')
@Controller('webhooks/mobile-money')
export class MobileMoneyWebhookController {
  constructor(private readonly webhooks: MobileMoneyWebhookService) {}

  @Post()
  // L'agregateur ne detient pas de cle d'API : ce point d'entree porte sa
  // propre authentification, la signature HMAC verifiee par le service.
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Recevoir une confirmation signee de l agregateur',
    description: [
      'La signature HMAC SHA-256 porte sur les champs eventId, aggregatorReference,',
      'status, amount (2 decimales), currency, occurredAt et failureReason,',
      'concatenes dans cet ordre et **prefixes de leur longueur** :',
      '`<nombre d octets UTF-8>:<valeur>` separes par « | ».',
      '',
      'Le prefixe de longueur est indispensable : sans lui, deplacer la frontiere',
      'entre deux champs adjacents produit la meme chaine signee, et donc une',
      'signature valide pour un autre aggregatorReference.',
    ].join('\n'),
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
