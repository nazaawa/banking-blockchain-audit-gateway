import { LOCAL_SECURITY_MASTER_KEY } from '../security/key-derivation';

/**
 * Validation des variables d'environnement au demarrage.
 *
 * Le processus doit echouer immediatement (fail-fast) si une variable critique
 * est absente ou mal formee : c'est preferable a une erreur en pleine
 * transaction bancaire.
 */

type Rule = {
  key: string;
  required?: boolean;
  kind?: 'string' | 'int' | 'float' | 'boolean' | 'url' | 'enum' | 'pattern';
  values?: string[];
  min?: number;
  max?: number;
  exclusiveMax?: boolean;
  minLength?: number;
  pattern?: RegExp;
  /** Description du format attendu, pour les regles `pattern`. */
  expected?: string;
  /**
   * Interdit de faire figurer la valeur dans le message d'erreur.
   * Un message de demarrage se retrouve dans les journaux et les tickets :
   * une cle privee ne doit jamais y transiter.
   */
  secret?: boolean;
};

const RULES: Rule[] = [
  { key: 'NODE_ENV', kind: 'enum', values: ['development', 'test', 'staging', 'production'] },
  { key: 'PORT', kind: 'int', min: 1 },
  { key: 'DB_HOST', required: true },
  { key: 'DB_PORT', kind: 'int', min: 1, required: true },
  { key: 'DB_USERNAME', required: true },
  { key: 'DB_PASSWORD', required: true },
  { key: 'DB_NAME', required: true },
  { key: 'DB_SYNCHRONIZE', kind: 'boolean' },
  { key: 'DB_LOGGING', kind: 'boolean' },
  { key: 'DB_SSL', kind: 'boolean' },
  { key: 'SOAP_ENDPOINT', kind: 'url', required: true },
  { key: 'SOAP_WSDL_SOURCE', kind: 'enum', values: ['local', 'remote'] },
  { key: 'SOAP_WSDL_URL', kind: 'url' },
  { key: 'SOAP_TIMEOUT_MS', kind: 'int', min: 100 },
  { key: 'SOAP_MAX_RETRIES', kind: 'int', min: 0 },
  { key: 'SOAP_RETRY_DELAY_MS', kind: 'int', min: 0 },
  { key: 'SOAP_MAX_RESPONSE_BYTES', kind: 'int', min: 1024 },
  { key: 'TRANSFER_MAX_AMOUNT', kind: 'float', min: 0 },
  { key: 'MOBILE_MONEY_FEE_RATE', kind: 'float', min: 0, max: 1, exclusiveMax: true },
  {
    key: 'MOBILE_MONEY_SETTLEMENT_IBAN',
    kind: 'pattern',
    pattern: /^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/,
    expected: 'un IBAN sans espaces',
  },
  { key: 'MOBILE_MONEY_SETTLEMENT_NAME', kind: 'string' },
  { key: 'MOBILE_MONEY_WEBHOOK_SECRET', kind: 'string', secret: true },
  { key: 'MOBILE_MONEY_SIMULATOR_ENABLED', kind: 'boolean' },
  { key: 'MOBILE_MONEY_BANK_WORKER_ENABLED', kind: 'boolean' },
  { key: 'MOBILE_MONEY_BANK_WORKER_INTERVAL_MS', kind: 'int', min: 100 },
  { key: 'MOBILE_MONEY_BANK_WORKER_MAX_ATTEMPTS', kind: 'int', min: 1 },
  { key: 'AUDIT_MAX_PAYLOAD_CHARS', kind: 'int', min: 0 },
  { key: 'AUDIT_PERSIST_PAYLOADS', kind: 'boolean' },
  { key: 'SWAGGER_ENABLED', kind: 'boolean' },
  { key: 'AUTH_ENABLED', kind: 'boolean' },
  {
    key: 'SECURITY_MASTER_KEY',
    kind: 'pattern',
    pattern: /^[A-Za-z0-9+/]{43}=$/,
    expected: 'une cle Base64 representant exactement 32 octets',
    secret: true,
  },
  {
    key: 'SECURITY_CURRENT_KEY_ID',
    kind: 'pattern',
    pattern: /^[A-Za-z0-9_-]{1,32}$/,
    expected: 'un identifiant de cle (1 a 32 lettres, chiffres, _ ou -)',
  },
  { key: 'SECURITY_KEY_SALT', kind: 'string', minLength: 16 },

  { key: 'BLOCKCHAIN_ENABLED', kind: 'boolean' },
  { key: 'BLOCKCHAIN_RPC_URL', kind: 'url' },
  { key: 'BLOCKCHAIN_CHAIN_ID', kind: 'int', min: 1 },
  {
    key: 'BLOCKCHAIN_CONTRACT_ADDRESS',
    kind: 'pattern',
    pattern: /^0x[0-9a-fA-F]{40}$/,
    expected: 'une adresse Ethereum (0x + 40 caracteres hexadecimaux)',
  },
  {
    key: 'BLOCKCHAIN_PRIVATE_KEY',
    kind: 'pattern',
    pattern: /^0x[0-9a-fA-F]{64}$/,
    expected: 'une cle privee (0x + 64 caracteres hexadecimaux)',
    secret: true,
  },
  { key: 'BLOCKCHAIN_CONFIRMATIONS', kind: 'int', min: 0 },
  { key: 'ANCHOR_BATCH_MAX_SIZE', kind: 'int', min: 1 },
  { key: 'ANCHOR_INTERVAL_MS', kind: 'int', min: 1000 },
  { key: 'ANCHOR_MAX_RETRIES', kind: 'int', min: 1 },
];

const BOOLEANS = ['1', '0', 'true', 'false', 'yes', 'no', 'on', 'off'];

function checkRule(rule: Rule, raw: string | undefined): string | null {
  if (raw === undefined || raw === '') {
    return rule.required ? `${rule.key} est requis mais absent` : null;
  }

  if (rule.minLength !== undefined && raw.length < rule.minLength) {
    return rule.secret
      ? `${rule.key} doit contenir au moins ${rule.minLength} caracteres (valeur masquee)`
      : `${rule.key} doit contenir au moins ${rule.minLength} caracteres`;
  }

  if (rule.kind === 'pattern') {
    if (rule.pattern?.test(raw)) return null;
    // Sur une variable sensible, on decrit le format attendu sans jamais
    // reproduire la valeur fournie.
    return rule.secret
      ? `${rule.key} doit etre ${rule.expected ?? 'au format attendu'} (valeur masquee)`
      : `${rule.key} doit etre ${rule.expected ?? 'au format attendu'} (recu: "${raw}")`;
  }

  switch (rule.kind) {
    case 'int': {
      if (!/^-?\d+$/.test(raw)) return `${rule.key} doit etre un entier (recu: "${raw}")`;
      if (rule.min !== undefined && Number.parseInt(raw, 10) < rule.min) {
        return `${rule.key} doit etre >= ${rule.min} (recu: "${raw}")`;
      }
      if (
        rule.max !== undefined &&
        (rule.exclusiveMax
          ? Number.parseInt(raw, 10) >= rule.max
          : Number.parseInt(raw, 10) > rule.max)
      ) {
        return `${rule.key} doit etre ${rule.exclusiveMax ? '<' : '<='} ${rule.max} (recu: "${raw}")`;
      }
      return null;
    }
    case 'float': {
      const parsed = Number.parseFloat(raw);
      if (!Number.isFinite(parsed)) return `${rule.key} doit etre un nombre (recu: "${raw}")`;
      if (rule.min !== undefined && parsed < rule.min) {
        return `${rule.key} doit etre >= ${rule.min} (recu: "${raw}")`;
      }
      if (rule.max !== undefined && (rule.exclusiveMax ? parsed >= rule.max : parsed > rule.max)) {
        return `${rule.key} doit etre ${rule.exclusiveMax ? '<' : '<='} ${rule.max} (recu: "${raw}")`;
      }
      return null;
    }
    case 'boolean':
      return BOOLEANS.includes(raw.toLowerCase())
        ? null
        : `${rule.key} doit etre un booleen (recu: "${raw}")`;
    case 'url': {
      try {
        const url = new URL(raw);
        return ['http:', 'https:'].includes(url.protocol)
          ? null
          : `${rule.key} doit utiliser http(s) (recu: "${raw}")`;
      } catch {
        return `${rule.key} doit etre une URL valide (recu: "${raw}")`;
      }
    }
    case 'enum':
      return rule.values?.includes(raw.toLowerCase())
        ? null
        : `${rule.key} doit valoir l'une de [${rule.values?.join(', ')}] (recu: "${raw}")`;
    default:
      return null;
  }
}

export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const errors = RULES.map((rule) =>
    checkRule(rule, config[rule.key] as string | undefined),
  ).filter((error): error is string => error !== null);

  const read = (key: string): string => {
    const value = config[key];
    return typeof value === 'string' ? value : '';
  };

  // Une API de paiement ouverte en production n'est pas un mode degrade : c'est
  // une faute. Le demarrage doit echouer, pas se contenter d'un avertissement.
  if (read('NODE_ENV') === 'production') {
    if (['0', 'false', 'no', 'off'].includes(read('AUTH_ENABLED').toLowerCase())) {
      errors.push('AUTH_ENABLED ne peut pas valoir false en production');
    }
    if (!read('API_KEYS').trim()) {
      errors.push('API_KEYS est requis en production : aucune cle declaree');
    }
    if (!read('SECURITY_MASTER_KEY') || read('SECURITY_MASTER_KEY') === LOCAL_SECURITY_MASTER_KEY) {
      errors.push(
        'SECURITY_MASTER_KEY doit etre un secret explicite en production (valeur masquee)',
      );
    }
    if (!read('SECURITY_CURRENT_KEY_ID') || read('SECURITY_CURRENT_KEY_ID') === 'local-v1') {
      errors.push('SECURITY_CURRENT_KEY_ID doit etre explicite en production');
    }
  }

  const previousKeys = read('SECURITY_PREVIOUS_KEYS');
  const currentMasterKey = read('SECURITY_MASTER_KEY');
  if (
    /^[A-Za-z0-9+/]{43}=$/.test(currentMasterKey) &&
    new Set(Buffer.from(currentMasterKey, 'base64')).size < 4
  ) {
    errors.push(
      'SECURITY_MASTER_KEY presente une entropie manifestement insuffisante (valeur masquee)',
    );
  }
  if (previousKeys) {
    const seen = new Set<string>();
    for (const entry of previousKeys.split(',')) {
      const [keyId, encoded, ...extra] = entry.trim().split('|');
      if (
        extra.length > 0 ||
        !/^[A-Za-z0-9_-]{1,32}$/.test(keyId ?? '') ||
        !/^[A-Za-z0-9+/]{43}=$/.test(encoded ?? '') ||
        new Set(Buffer.from(encoded ?? '', 'base64')).size < 4 ||
        seen.has(keyId) ||
        keyId === read('SECURITY_CURRENT_KEY_ID')
      ) {
        errors.push(
          'SECURITY_PREVIOUS_KEYS doit contenir des entrees uniques keyId|Base64-32-octets ' +
            '(valeurs masquees), distinctes de SECURITY_CURRENT_KEY_ID',
        );
        break;
      }
      seen.add(keyId);
    }
  }

  if (
    config.NODE_ENV === 'production' &&
    (!config.MOBILE_MONEY_WEBHOOK_SECRET ||
      config.MOBILE_MONEY_WEBHOOK_SECRET === 'local-demo-webhook-secret')
  ) {
    errors.push('MOBILE_MONEY_WEBHOOK_SECRET doit etre un secret explicite en production');
  }

  if (errors.length > 0) {
    throw new Error(
      `Configuration invalide — corrigez votre fichier .env :\n  - ${errors.join('\n  - ')}`,
    );
  }

  return config;
}
