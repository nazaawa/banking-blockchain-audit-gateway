/**
 * Masquage des donnees sensibles avant journalisation ou persistance d'audit.
 *
 * Regle du projet : aucun IBAN complet, aucun secret et aucun en-tete
 * d'authentification ne doit jamais atteindre les logs ou la table d'audit.
 */

/** Cles dont la valeur est integralement remplacee par un marqueur. */
const REDACTED_KEYS = new Set([
  'password',
  'passwd',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'apikey',
  'api_key',
  'clientsecret',
  'privatekey',
  'cvv',
  'cvc',
  'pin',
]);

/** Cles traitees comme un IBAN : on conserve un prefixe/suffixe lisible. */
const IBAN_KEYS = new Set([
  'iban',
  'debtoriban',
  'creditoriban',
  'debtoraccount',
  'creditoraccount',
  'accountnumber',
  'account_number',
  'compte',
]);

/** Cles traitees comme un identifiant partiellement masquable (BIC, PAN...). */
const PARTIAL_KEYS = new Set([
  'bic',
  'swift',
  'pan',
  'cardnumber',
  'card_number',
  'phone',
  'email',
]);

export const REDACTED = '[REDACTED]';

const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 25;

/**
 * Masque un IBAN en conservant le pays + les 2 cles de controle et les
 * 4 derniers caracteres : `FR7630006000011234567890189` -> `FR76****0189`.
 */
export function maskIban(value: string): string {
  const normalized = value.replace(/\s+/g, '');
  if (normalized.length < 8) return REDACTED;
  return `${normalized.slice(0, 4)}****${normalized.slice(-4)}`;
}

/** Masque une chaine quelconque en ne laissant que les 2 derniers caracteres. */
export function maskPartial(value: string, keepStart = 2, keepEnd = 2): string {
  if (value.length <= keepStart + keepEnd) return REDACTED;
  return `${value.slice(0, keepStart)}****${value.slice(-keepEnd)}`;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, '');
}

function maskByKey(key: string, value: string): string {
  const normalized = normalizeKey(key);
  if (REDACTED_KEYS.has(normalized)) return REDACTED;
  if (IBAN_KEYS.has(normalized)) return maskIban(value);
  if (PARTIAL_KEYS.has(normalized)) return maskPartial(value);
  return value;
}

/** Detecte un IBAN "en clair" au milieu d'un texte libre. */
const IBAN_PATTERN = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g;

/** Detecte une suite de 13 chiffres ou plus (numero de compte / carte). */
const LONG_DIGITS_PATTERN = /\b\d{13,}\b/g;

/** Masque les IBAN et longues suites de chiffres presents dans un texte libre. */
export function maskFreeText(text: string): string {
  return text
    .replace(IBAN_PATTERN, (match) => maskIban(match))
    .replace(LONG_DIGITS_PATTERN, (match) => maskPartial(match, 4, 2));
}

/**
 * Masque recursivement un objet (body HTTP, en-tetes, payload d'erreur...).
 * La structure est conservee pour rester exploitable en observabilite.
 */
export function maskDeep(input: unknown, depth = 0): unknown {
  if (input === null || input === undefined) return input;
  if (depth > MAX_DEPTH) return '[TRUNCATED]';

  if (typeof input === 'string') return maskFreeText(input);
  if (typeof input === 'number' || typeof input === 'boolean') return input;
  if (input instanceof Date) return input.toISOString();

  if (Array.isArray(input)) {
    const items = input.slice(0, MAX_ARRAY_ITEMS).map((item) => maskDeep(item, depth + 1));
    if (input.length > MAX_ARRAY_ITEMS) {
      items.push(`[... ${input.length - MAX_ARRAY_ITEMS} elements supplementaires]`);
    }
    return items;
  }

  if (typeof input === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (typeof value === 'string') {
        const masked = maskByKey(key, value);
        output[key] = masked === value ? maskFreeText(value) : masked;
      } else if (REDACTED_KEYS.has(normalizeKey(key))) {
        output[key] = REDACTED;
      } else {
        output[key] = maskDeep(value, depth + 1);
      }
    }
    return output;
  }

  return REDACTED;
}

/** Noms de balises XML dont le contenu textuel doit etre masque. */
const SENSITIVE_XML_TAGS = [
  'iban',
  'debtorIban',
  'creditorIban',
  'accountNumber',
  'bic',
  'password',
  'token',
];

const XML_TAG_PATTERN = new RegExp(
  `(<(?:[\\w.-]+:)?(${SENSITIVE_XML_TAGS.join('|')})\\b[^>]*>)([\\s\\S]*?)(</(?:[\\w.-]+:)?\\2>)`,
  'gi',
);

/**
 * Masque un document XML (requete ou reponse SOAP) avant journalisation :
 * contenu des balises sensibles, puis IBAN/longues suites de chiffres residuels.
 */
export function maskXml(xml: string): string {
  return maskFreeText(
    xml.replace(
      XML_TAG_PATTERN,
      (_match, open: string, tag: string, content: string, close: string) => {
        const masked = IBAN_KEYS.has(normalizeKey(tag)) ? maskIban(content.trim()) : REDACTED;
        return `${open}${masked}${close}`;
      },
    ),
  );
}

/** Tronque une chaine en signalant explicitement la troncature. */
export function truncate(value: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}... [tronque, ${value.length} caracteres au total]`;
}
