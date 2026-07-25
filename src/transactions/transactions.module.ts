import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { SoapModule } from '../soap/soap.module';
import { Transaction } from './entities/transaction.entity';
import { ReferenceGenerator } from './reference.generator';
import { TransactionsController } from './transactions.controller';
import { TransactionsRepository } from './transactions.repository';
import { TransactionsService } from './transactions.service';

@Module({
  imports: [TypeOrmModule.forFeature([Transaction]), SoapModule, AuditModule],
  controllers: [TransactionsController],
  providers: [TransactionsService, TransactionsRepository, ReferenceGenerator],
  exports: [TransactionsService],
})
export class TransactionsModule {}
