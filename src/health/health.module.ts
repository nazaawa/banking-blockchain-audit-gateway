import { Module } from '@nestjs/common';
import { SoapModule } from '../soap/soap.module';
import { HealthController } from './health.controller';

@Module({
  imports: [SoapModule],
  controllers: [HealthController],
})
export class HealthModule {}
