import { hkdfSync } from 'node:crypto';

export const DATA_KEY_BYTES = 32;
export const LOCAL_SECURITY_MASTER_KEY = Buffer.from(
  'local-demo-master-key-32-bytes!!',
  'utf8',
).toString('base64');
export const LEGACY_LOCAL_SECURITY_MASTER_KEY = 'local-demo-master-key-a-remplacer';
export const LOCAL_SECURITY_KEY_ID = 'local-v1';
export const DEFAULT_SECURITY_KEY_SALT = 'banking-gateway-hkdf-salt';

export interface EncodedKey {
  keyId: string;
  masterKey: string;
}

export const decodeMasterKey = (encoded: string): Buffer => {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
    throw new Error('Cle maitresse invalide : format Base64-32-octets attendu');
  }
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length !== DATA_KEY_BYTES) {
    throw new Error(
      `Cle maitresse invalide : ${decoded.length} octets decodes au lieu de ${DATA_KEY_BYTES}`,
    );
  }
  if (new Set(decoded).size < 4) {
    throw new Error('Cle maitresse invalide : entropie manifestement insuffisante');
  }
  return decoded;
};

/** Derive une cle propre au chiffrement des donnees de partie. */
export const deriveDataEncryptionKey = (masterKey: Buffer, keySalt: string): Buffer =>
  Buffer.from(hkdfSync('sha256', masterKey, keySalt, 'iban-at-rest', DATA_KEY_BYTES));

/**
 * Reproduit exactement la derivation utilisee avant l'introduction du keyring.
 *
 * Reserve a la migration des chiffres sans identifiant de cle. L'application
 * normale ne doit jamais accepter ce materiel au format libre.
 */
export const deriveLegacyDataEncryptionKey = (legacyMasterKey: string, keySalt: string): Buffer =>
  Buffer.from(hkdfSync('sha256', legacyMasterKey, keySalt, 'iban-at-rest', DATA_KEY_BYTES));

/** Parse `keyId|base64,keyId|base64` sans jamais journaliser les valeurs. */
export const parsePreviousKeys = (raw: string): EncodedKey[] =>
  raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf('|');
      if (separator <= 0) throw new Error('Entree SECURITY_PREVIOUS_KEYS invalide');
      return {
        keyId: entry.slice(0, separator),
        masterKey: entry.slice(separator + 1),
      };
    });
