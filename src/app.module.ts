import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { AuditModule } from './audit/audit.module';
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
    DatabaseModule,
    SoapModule,
    XmlModule,
    BlockchainModule,
    EventsModule,
    RefundsModule,
    AuditModule,
    TransactionsModule,
    MobileMoneyModule,
    HealthModule,
  ],
  providers: [
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
