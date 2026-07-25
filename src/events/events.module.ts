import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { AnchorBatch } from '../blockchain/entities/anchor-batch.entity';
import { XmlModule } from '../xml/xml.module';
import { AppendOnlyGuardInstaller } from './append-only-guard.installer';
import { TransactionEvent } from './entities/transaction-event.entity';
import { EventChainVerificationService } from './event-chain-verification.service';
import { TransactionEventXmlBuilder } from './transaction-event-xml.builder';
import { TransactionEventsService } from './transaction-events.service';
import { TransactionEventsController } from './transaction-events.controller';
import { Transaction } from '../transactions/entities/transaction.entity';

/**
 * Registre append-only des faits metier.
 *
 * Ne depend ni de TransactionsModule ni de MobileMoneyModule : ce sont eux qui
 * consomment ce registre. La dependance reste unidirectionnelle, sinon le
 * scellement d'un fait pourrait declencher un fait.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([TransactionEvent, AnchorBatch, Transaction]),
    BlockchainModule,
    XmlModule,
  ],
  controllers: [TransactionEventsController],
  providers: [
    AppendOnlyGuardInstaller,
    TransactionEventsService,
    TransactionEventXmlBuilder,
    EventChainVerificationService,
  ],
  exports: [TransactionEventsService, EventChainVerificationService, TransactionEventXmlBuilder],
})
export class EventsModule {}
