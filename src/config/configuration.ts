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

export const mobileMoneyConfig = registerAs('mobileMoney', () => ({
  /**
   * Compte technique credite par l'agregateur avant l'instruction bancaire.
   * Il remplace le compte donneur d'ordre saisi dans l'ancien flux.
   */
  settlementIban: process.env.MOBILE_MONEY_SETTLEMENT_IBAN ?? 'FR7630006000011234567890189',
  settlementName: process.env.MOBILE_MONEY_SETTLEMENT_NAME ?? 'Mobile Money Settlement',
  /**
   * Commission retenue par la passerelle sur un encaissement conforme.
   *
   * Exprimee en fraction (0.015 = 1,5 %). Le montant calcule est **fige** sur la
   * transaction a la confirmation : une evolution du taux ne doit pas modifier
   * retroactivement des ecritures comptables deja passees.
   */
  feeRate: toFloat(process.env.MOBILE_MONEY_FEE_RATE, 0.015),
  /** Secret partage utilise pour authentifier les callbacks HMAC SHA-256. */
  webhookSecret: process.env.MOBILE_MONEY_WEBHOOK_SECRET ?? 'local-demo-webhook-secret',
  simulatorEnabled: toBool(
    process.env.MOBILE_MONEY_SIMULATOR_ENABLED,
    process.env.NODE_ENV !== 'production',
  ),
}));

export const auditConfig = registerAs('audit', () => ({
  maxPayloadChars: toInt(process.env.AUDIT_MAX_PAYLOAD_CHARS, 8000),
  persistPayloads: toBool(process.env.AUDIT_PERSIST_PAYLOADS, true),
}));

/**
 * Cle privee du compte #0 d'Anvil et du noeud Hardhat.
 *
 * Publique par construction et sans valeur hors d'une chaine locale jetable.
 * En production, cette cle proviendrait d'un HSM ou d'un KMS, jamais d'une
 * variable d'environnement — voir la section « Limites » du README.
 */
const LOCAL_DEV_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

/**
 * Secrets de la passerelle.
 *
 * `masterKey` n'est jamais utilise directement : la garde en derive des cles par
 * usage, afin qu'une compromission n'en livre pas d'autres.
 */
export const securityConfig = registerAs('security', () => ({
  masterKey: process.env.SECURITY_MASTER_KEY ?? 'local-demo-master-key-a-remplacer',
  keySalt: process.env.SECURITY_KEY_SALT ?? 'banking-gateway-hkdf-salt',
}));

export const blockchainConfig = registerAs('blockchain', () => ({
  enabled: toBool(process.env.BLOCKCHAIN_ENABLED, true),
  rpcUrl: process.env.BLOCKCHAIN_RPC_URL ?? 'http://127.0.0.1:8545',
  chainId: toInt(process.env.BLOCKCHAIN_CHAIN_ID, 31337),
  contractAddress: process.env.BLOCKCHAIN_CONTRACT_ADDRESS ?? '',
  privateKey: process.env.BLOCKCHAIN_PRIVATE_KEY ?? LOCAL_DEV_PRIVATE_KEY,
  /** Confirmations attendues avant de considerer l'ancrage acquis. */
  confirmations: toInt(process.env.BLOCKCHAIN_CONFIRMATIONS, 1),
}));

export const anchorConfig = registerAs('anchor', () => ({
  /** Nombre maximum de transactions regroupees dans un lot. */
  batchMaxSize: toInt(process.env.ANCHOR_BATCH_MAX_SIZE, 50),
  /** Periode de constitution des lots, en millisecondes. */
  intervalMs: toInt(process.env.ANCHOR_INTERVAL_MS, 15_000),
  /** Reprises avant d'abandonner definitivement un lot. */
  maxRetries: toInt(process.env.ANCHOR_MAX_RETRIES, 3),
}));

export const authConfig = registerAs('auth', () => ({
  /**
   * `false` ouvre l'API en grand, remboursements compris. Refuse en production
   * par la validation d'environnement.
   */
  enabled: toBool(process.env.AUTH_ENABLED, true),
  /**
   * Entrees `keyId|sha256Hex|scope1,scope2|libelle`, separees par `;`.
   * Seules des empreintes y figurent : jamais un secret exploitable.
   */
  apiKeys: (process.env.API_KEYS ?? '')
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean),
}));

export const configurations = [
  appConfig,
  databaseConfig,
  soapConfig,
  businessConfig,
  mobileMoneyConfig,
  auditConfig,
  authConfig,
  securityConfig,
  blockchainConfig,
  anchorConfig,
];
