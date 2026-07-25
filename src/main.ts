import 'reflect-metadata';
import { Logger, LogLevel, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { CORRELATION_ID_HEADER } from './common/middleware/correlation-id.middleware';

const LOG_LEVELS: Record<string, LogLevel[]> = {
  error: ['error'],
  warn: ['error', 'warn'],
  log: ['error', 'warn', 'log'],
  debug: ['error', 'warn', 'log', 'debug'],
  verbose: ['error', 'warn', 'log', 'debug', 'verbose'],
};

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  app.useLogger(LOG_LEVELS[config.get<string>('app.logLevel') ?? 'log'] ?? LOG_LEVELS.log);

  app.use(helmet());
  app.enableCors({
    origin: true,
    exposedHeaders: [CORRELATION_ID_HEADER],
  });

  const apiPrefix = config.get<string>('app.apiPrefix') ?? 'api/v1';
  app.setGlobalPrefix(apiPrefix);

  app.useGlobalPipes(
    new ValidationPipe({
      // Retire silencieusement les champs non declares dans les DTO...
      whitelist: true,
      // ...et rejette la requete si elle en contient : un champ inattendu sur
      // une API bancaire est le signe d'une erreur d'integration, pas d'un extra.
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      // Les messages detailles restent utiles hors production.
      disableErrorMessages: config.get<string>('app.env') === 'production',
    }),
  );

  app.enableShutdownHooks();

  if (config.get<boolean>('app.swaggerEnabled')) {
    const swaggerPath = config.get<string>('app.swaggerPath') ?? 'api/docs';
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Banking SOAP Integration Demo')
        .setDescription(
          [
            'API d initiation de virement bancaire adossee a un service SOAP public.',
            '',
            'Chaine de traitement : reception JSON -> validation (IBAN MOD 97-10, montant,',
            'devise) -> generation d une reference unique -> appel SOAP `NumberToDollars`',
            '(DataAccess Number Conversion) -> analyse de la reponse XML -> persistance',
            'PostgreSQL -> consultation du statut.',
            '',
            '**Confidentialite** : les IBAN sont masques dans les reponses, les logs et la',
            'piste d audit. Aucun IBAN complet ne quitte la base de donnees.',
          ].join('\n'),
        )
        .setVersion('1.0')
        .addTag('transfers', 'Initiation et consultation des virements')
        .addTag('health', 'Supervision')
        .addGlobalParameters({
          name: CORRELATION_ID_HEADER,
          in: 'header',
          required: false,
          schema: { type: 'string' },
          description: 'Identifiant de correlation propage dans les logs et l audit',
        })
        .build(),
    );

    SwaggerModule.setup(swaggerPath, app, document, {
      swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
    });

    logger.log(`Documentation Swagger disponible sur /${swaggerPath}`);
  }

  const port = config.get<number>('app.port') ?? 3000;
  await app.listen(port, '0.0.0.0');

  logger.log(`API demarree sur http://localhost:${port}/${apiPrefix}`);
}

void bootstrap();
