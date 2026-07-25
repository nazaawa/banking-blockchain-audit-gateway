import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnchorBatch } from '../blockchain/entities/anchor-batch.entity';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { TransactionEvent } from '../events/entities/transaction-event.entity';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { RestoreVerificationService } from './restore-verification.service';

/**
 * Supervision.
 *
 * Global : les compteurs sont alimentes depuis les modules metier, et un
 * registre par module produirait des series partielles impossibles a agreger.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AnchorBatch, TransactionEvent]), BlockchainModule],
  controllers: [MetricsController],
  providers: [MetricsService, RestoreVerificationService],
  exports: [MetricsService, RestoreVerificationService],
})
export class ObservabilityModule {}
