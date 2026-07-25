import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Transaction } from '../transactions/entities/transaction.entity';
import { TransactionEvent } from '../events/entities/transaction-event.entity';
import { XmlModule } from '../xml/xml.module';
import { AnchorService } from './anchor.service';
import { AnchorsController } from './anchors.controller';
import { AnchorBatch } from './entities/anchor-batch.entity';
import { EvmAnchorClient } from './evm-anchor.client';

/**
 * Scellement cryptographique, ancrage blockchain et controle d'integrite.
 *
 * Le module depend de `Transaction` mais pas de `TransactionsModule` : la
 * dependance est unidirectionnelle, ce qui evite un cycle avec le module metier
 * qui, lui, consomme `AnchorService` pour sceller ses transactions.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([AnchorBatch, Transaction, TransactionEvent]),
    ScheduleModule.forRoot(),
    XmlModule,
  ],
  controllers: [AnchorsController],
  providers: [AnchorService, EvmAnchorClient],
  exports: [AnchorService, EvmAnchorClient],
})
export class BlockchainModule {}
