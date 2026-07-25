import { Module } from '@nestjs/common';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { SoapModule } from '../soap/soap.module';
import { XmlModule } from '../xml/xml.module';
import { HealthController } from './health.controller';

@Module({
  imports: [SoapModule, XmlModule, BlockchainModule],
  controllers: [HealthController],
})
export class HealthModule {}
