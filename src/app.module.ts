import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { ApiKeyGuard } from './auth/guards/api-key.guard';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware';
import { configurations } from './config/configuration';
import { validateEnv } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { SoapModule } from './soap/soap.module';
import { XmlModule } from './xml/xml.module';
import { BlockchainModule } from './blockchain/blockchain.module';
import { EventsModule } from './events/events.module';
import { RefundsModule } from './refunds/refunds.module';
import { SecurityModule } from './security/security.module';
import { AccountingModule } from './accounting/accounting.module';
import { TreasuryModule } from './treasury/treasury.module';
import { TransactionStateModule } from './transactions/state/transaction-state.module';
import { TransactionsModule } from './transactions/transactions.module';
import { MobileMoneyModule } from './mobile-money/mobile-money.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: configurations,
      validate: validateEnv,
      envFilePath: ['.env.local', '.env'],
    }),
    SecurityModule,
    AuthModule,
    DatabaseModule,
    TransactionStateModule,
    SoapModule,
    XmlModule,
    BlockchainModule,
    EventsModule,
    AccountingModule,
    TreasuryModule,
    RefundsModule,
    AuditModule,
    TransactionsModule,
    MobileMoneyModule,
    HealthModule,
  ],
  providers: [
    // Refus par defaut : une route non marquee `@Public()` exige une cle.
    { provide: APP_GUARD, useClass: ApiKeyGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Le contexte de correlation doit envelopper toute la chaine de traitement.
    consumer.apply(CorrelationIdMiddleware).forRoutes('*path');
  }
}
