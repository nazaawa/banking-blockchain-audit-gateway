import { Module } from '@nestjs/common';
import { SoapClientService } from './soap-client.service';
import { SoapResponseMapper } from './soap-response.mapper';

/** Couche d'integration avec le service SOAP externe (anti-corruption layer). */
@Module({
  providers: [SoapClientService, SoapResponseMapper],
  exports: [SoapClientService, SoapResponseMapper],
})
export class SoapModule {}
