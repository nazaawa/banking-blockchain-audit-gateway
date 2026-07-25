import { registerAs } from '@nestjs/config';
import { join } from 'node:path';

const toBool = (value: string | undefined, fallback = false): boolean => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

const toInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toFloat = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toList = (value: string | undefined, fallback: string[]): string[] => {
  if (!value) return fallback;
  const items = value
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
};

export const appConfig = registerAs('app', () => ({
  env: process.env.NODE_ENV ?? 'development',
  port: toInt(process.env.PORT, 3000),
  apiPrefix: process.env.API_PREFIX ?? 'api/v1',
  swaggerEnabled: toBool(process.env.SWAGGER_ENABLED, true),
  swaggerPath: process.env.SWAGGER_PATH ?? 'api/docs',
  logLevel: process.env.LOG_LEVEL ?? 'log',
}));

export const databaseConfig = registerAs('database', () => ({
  host: process.env.DB_HOST ?? 'localhost',
  port: toInt(process.env.DB_PORT, 5432),
  username: process.env.DB_USERNAME ?? 'banking',
  password: process.env.DB_PASSWORD ?? 'banking',
  database: process.env.DB_NAME ?? 'banking_soap',
  synchronize: toBool(process.env.DB_SYNCHRONIZE, false),
  logging: toBool(process.env.DB_LOGGING, false),
  ssl: toBool(process.env.DB_SSL, false),
}));

export const soapConfig = registerAs('soap', () => ({
  endpoint:
    process.env.SOAP_ENDPOINT ??
    'https://www.dataaccess.com/webservicesserver/NumberConversion.wso',
  /** `local` : WSDL embarque (aucun appel reseau au boot) — `remote` : WSDL telecharge. */
  wsdlSource: (process.env.SOAP_WSDL_SOURCE ?? 'local').toLowerCase() as 'local' | 'remote',
  wsdlUrl:
    process.env.SOAP_WSDL_URL ??
    'https://www.dataaccess.com/webservicesserver/NumberConversion.wso?WSDL',
  wsdlPath: join(__dirname, '..', 'soap', 'wsdl', 'NumberConversion.wsdl'),
  timeoutMs: toInt(process.env.SOAP_TIMEOUT_MS, 8000),
  maxRetries: toInt(process.env.SOAP_MAX_RETRIES, 2),
  retryDelayMs: toInt(process.env.SOAP_RETRY_DELAY_MS, 300),
  maxResponseBytes: toInt(process.env.SOAP_MAX_RESPONSE_BYTES, 1_048_576),
}));

export const businessConfig = registerAs('business', () => ({
  allowedCurrencies: toList(process.env.ALLOWED_CURRENCIES, [
    'EUR',
    'USD',
    'GBP',
    'CHF',
    'XOF',
    'XAF',
    'CDF',
  ]),
  maxAmount: toFloat(process.env.TRANSFER_MAX_AMOUNT, 999_999_999.99),
}));

export const auditConfig = registerAs('audit', () => ({
  maxPayloadChars: toInt(process.env.AUDIT_MAX_PAYLOAD_CHARS, 8000),
  persistPayloads: toBool(process.env.AUDIT_PERSIST_PAYLOADS, true),
}));

export const configurations = [appConfig, databaseConfig, soapConfig, businessConfig, auditConfig];
