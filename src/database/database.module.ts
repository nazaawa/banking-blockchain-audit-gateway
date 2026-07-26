import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLog } from '../audit/entities/audit-log.entity';
import { AnchorBatch } from '../blockchain/entities/anchor-batch.entity';
import { TransactionEvent } from '../events/entities/transaction-event.entity';
import { Refund } from '../refunds/entities/refund.entity';
import { Transaction } from '../transactions/entities/transaction.entity';
import { MobileMoneyWebhookEvent } from '../mobile-money/entities/mobile-money-webhook-event.entity';
import { JournalEntry } from '../accounting/entities/journal-entry.entity';
import { JournalLine } from '../accounting/entities/journal-line.entity';
import { BankInstruction } from '../mobile-money/entities/bank-instruction.entity';

/** Entites gerees par TypeORM, partagees avec la CLI de migration. */
export const ENTITIES = [
  Transaction,
  AuditLog,
  AnchorBatch,
  MobileMoneyWebhookEvent,
  TransactionEvent,
  Refund,
  JournalEntry,
  JournalLine,
  BankInstruction,
];

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        host: config.getOrThrow<string>('database.host'),
        port: config.getOrThrow<number>('database.port'),
        username: config.getOrThrow<string>('database.username'),
        password: config.getOrThrow<string>('database.password'),
        database: config.getOrThrow<string>('database.database'),
        entities: ENTITIES,
        // `synchronize` est reserve au developpement : en production, on passe
        // par les migrations (`npm run migration:run`).
        synchronize: config.get<boolean>('database.synchronize') ?? false,
        logging: config.get<boolean>('database.logging') ?? false,
        ssl: config.get<boolean>('database.ssl') ? { rejectUnauthorized: false } : false,
        autoLoadEntities: true,
        // Evite qu'un demarrage se bloque indefiniment si la base est absente.
        connectTimeoutMS: 10_000,
        retryAttempts: 5,
        retryDelay: 2_000,
      }),
    }),
  ],
})
export class DatabaseModule {}
