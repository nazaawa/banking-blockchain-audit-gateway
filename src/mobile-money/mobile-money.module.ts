import { Module, type OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { EventsModule } from '../events/events.module';
import { SoapModule } from '../soap/soap.module';
import { Transaction } from '../transactions/entities/transaction.entity';
import { ReferenceGenerator } from '../transactions/reference.generator';
import { TransactionsRepository } from '../transactions/transactions.repository';
import { AggregatorSimulatorController } from './aggregator-simulator.controller';
import { AggregatorSimulatorService } from './aggregator-simulator.service';
import { BankInstructionWorker } from './bank-instruction.worker';
import { BankInstruction } from './entities/bank-instruction.entity';
import { MobileMoneyWebhookEvent } from './entities/mobile-money-webhook-event.entity';
import { MobileMoneyController } from './mobile-money.controller';
import { MobileMoneyService } from './mobile-money.service';
import { MobileMoneyWebhookController } from './mobile-money-webhook.controller';
import { MobileMoneyWebhookService } from './mobile-money-webhook.service';
import { ReconciliationService } from './reconciliation.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Transaction, MobileMoneyWebhookEvent, BankInstruction]),
    SoapModule,
    AuditModule,
    EventsModule,
  ],
  controllers: [MobileMoneyController, MobileMoneyWebhookController, AggregatorSimulatorController],
  providers: [
    MobileMoneyService,
    MobileMoneyWebhookService,
    AggregatorSimulatorService,
    ReconciliationService,
    BankInstructionWorker,
    TransactionsRepository,
    ReferenceGenerator,
  ],
  exports: [MobileMoneyService, ReconciliationService, BankInstructionWorker],
})
/**
 * Le travailleur recoit son execution bancaire **apres** construction du module.
 *
 * Une injection directe creerait un cycle : le service webhook depend du
 * travailleur pour mettre en file, le travailleur dependrait du service pour
 * executer. Brancher l'execution ici garde la dependance a sens unique.
 */
export class MobileMoneyModule implements OnModuleInit {
  constructor(
    private readonly worker: BankInstructionWorker,
    private readonly webhook: MobileMoneyWebhookService,
  ) {}

  onModuleInit(): void {
    this.worker.useExecutor(async (transaction) => {
      await this.webhook.executeBankInstruction(transaction);
    });
  }
}
