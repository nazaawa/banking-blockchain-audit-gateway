import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { SoapModule } from '../soap/soap.module';
import { XmlModule } from '../xml/xml.module';
import { Transaction } from './entities/transaction.entity';
import { ReferenceGenerator } from './reference.generator';
import { TransactionsController } from './transactions.controller';
import { TransactionsRepository } from './transactions.repository';
import { TransactionsService } from './transactions.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Transaction]),
    SoapModule,
    AuditModule,
    XmlModule,
    BlockchainModule,
  ],
  controllers: [TransactionsController],
  providers: [TransactionsService, TransactionsRepository, ReferenceGenerator],
  exports: [TransactionsService],
})
export class TransactionsModule {}
