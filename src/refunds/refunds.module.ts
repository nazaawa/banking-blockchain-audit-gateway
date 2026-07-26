import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventsModule } from '../events/events.module';
import { Transaction } from '../transactions/entities/transaction.entity';
import { Refund } from './entities/refund.entity';
import { PROVIDER_REFUND_PORT } from './provider-refund.port';
import { RefundsController } from './refunds.controller';
import { RefundRetryWorker } from './refund-retry.worker';
import { RefundsService } from './refunds.service';
import { SimulatorRefundAdapter } from './simulator-refund.adapter';

/**
 * Remboursement du payeur.
 *
 * Le fournisseur est injecte derriere un port : substituer un vrai agregateur
 * au simulateur ne touche ni le service ni le controleur.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Refund, Transaction]), EventsModule],
  controllers: [RefundsController],
  providers: [
    RefundsService,
    RefundRetryWorker,
    SimulatorRefundAdapter,
    { provide: PROVIDER_REFUND_PORT, useExisting: SimulatorRefundAdapter },
  ],
  exports: [RefundsService],
})
export class RefundsModule {}
