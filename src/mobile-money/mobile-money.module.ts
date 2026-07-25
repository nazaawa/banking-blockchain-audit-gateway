import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { EventsModule } from '../events/events.module';
import { SoapModule } from '../soap/soap.module';
import { Transaction } from '../transactions/entities/transaction.entity';
import { ReferenceGenerator } from '../transactions/reference.generator';
import { TransactionsRepository } from '../transactions/transactions.repository';
import { AggregatorSimulatorController } from './aggregator-simulator.controller';
import { AggregatorSimulatorService } from './aggregator-simulator.service';
import { MobileMoneyWebhookEvent } from './entities/mobile-money-webhook-event.entity';
import { MobileMoneyController } from './mobile-money.controller';
import { MobileMoneyService } from './mobile-money.service';
import { MobileMoneyWebhookController } from './mobile-money-webhook.controller';
import { MobileMoneyWebhookService } from './mobile-money-webhook.service';
import { ReconciliationService } from './reconciliation.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Transaction, MobileMoneyWebhookEvent]),
    SoapModule,
    AuditModule,
    BlockchainModule,
    EventsModule,
  ],
  controllers: [MobileMoneyController, MobileMoneyWebhookController, AggregatorSimulatorController],
  providers: [
    MobileMoneyService,
    MobileMoneyWebhookService,
    AggregatorSimulatorService,
    ReconciliationService,
    TransactionsRepository,
    ReferenceGenerator,
  ],
  exports: [MobileMoneyService, ReconciliationService],
})
export class MobileMoneyModule {}
