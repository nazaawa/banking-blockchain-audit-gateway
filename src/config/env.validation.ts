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
  kind?: 'string' | 'int' | 'float' | 'boolean' | 'url' | 'enum';
  values?: string[];
  min?: number;
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
  { key: 'AUDIT_MAX_PAYLOAD_CHARS', kind: 'int', min: 0 },
  { key: 'AUDIT_PERSIST_PAYLOADS', kind: 'boolean' },
  { key: 'SWAGGER_ENABLED', kind: 'boolean' },
];

const BOOLEANS = ['1', '0', 'true', 'false', 'yes', 'no', 'on', 'off'];

function checkRule(rule: Rule, raw: string | undefined): string | null {
  if (raw === undefined || raw === '') {
    return rule.required ? `${rule.key} est requis mais absent` : null;
  }

  switch (rule.kind) {
    case 'int': {
      if (!/^-?\d+$/.test(raw)) return `${rule.key} doit etre un entier (recu: "${raw}")`;
      if (rule.min !== undefined && Number.parseInt(raw, 10) < rule.min) {
        return `${rule.key} doit etre >= ${rule.min} (recu: "${raw}")`;
      }
      return null;
    }
    case 'float': {
      const parsed = Number.parseFloat(raw);
      if (!Number.isFinite(parsed)) return `${rule.key} doit etre un nombre (recu: "${raw}")`;
      if (rule.min !== undefined && parsed < rule.min) {
        return `${rule.key} doit etre >= ${rule.min} (recu: "${raw}")`;
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
  const errors = RULES.map((rule) => checkRule(rule, config[rule.key] as string | undefined)).filter(
    (error): error is string => error !== null,
  );

  if (errors.length > 0) {
    throw new Error(
      `Configuration invalide — corrigez votre fichier .env :\n  - ${errors.join('\n  - ')}`,
    );
  }

  return config;
}
