import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Marqueur de version en tete de chaque valeur chiffree.
 *
 * Il remplit deux roles : distinguer un chiffre d'un clair herite, et permettre
 * une rotation d'algorithme sans ambiguite sur les donnees deja ecrites.
 */
const PREFIX = 'enc.v1';
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Chiffrement des champs sensibles au repos (AES-256-GCM).
 *
 * ## Pourquoi une cle detenue statiquement
 *
 * Les transformateurs TypeORM sont **synchrones**, alors que la garde des cles
 * expose une interface asynchrone. La cle est donc resolue une fois au demarrage
 * et conservee ici. C'est le seul point du systeme ou un secret vit dans une
 * variable de module — le rendre explicite vaut mieux que de le disperser.
 *
 * ## Pourquoi l'echec est bruyant
 *
 * Si la cle n'est pas installee, `encrypt` **leve**. Le reflexe inverse — se
 * rabattre sur le clair — produirait exactement le defaut que ce chiffrement
 * existe pour empecher : une base qu'on croit protegee et qui ne l'est pas.
 * Mieux vaut un service qui refuse d'ecrire qu'un service qui ment.
 *
 * Toute valeur persistante doit porter le prefixe de version. Les donnees
 * historiques sont converties par migration, puis des contraintes PostgreSQL
 * interdisent leur retour au clair.
 */
export class FieldCipher {
  private static currentKeyId: string | null = null;
  private static keys = new Map<string, Buffer>();

  /** Compatibilite des tests simples : installe une cle unique. */
  static useKey(key: Buffer): void {
    FieldCipher.useKeyRing('test', new Map([['test', key]]));
  }

  /** Installe la cle courante et les anciennes cles disponibles en lecture. */
  static useKeyRing(currentKeyId: string, keys: ReadonlyMap<string, Buffer>): void {
    if (!KEY_ID_PATTERN.test(currentKeyId)) {
      throw new Error(`Identifiant de cle invalide : ${currentKeyId}`);
    }
    if (!keys.has(currentKeyId)) {
      throw new Error(`Cle courante absente du keyring : ${currentKeyId}`);
    }
    for (const [keyId, key] of keys) {
      if (!KEY_ID_PATTERN.test(keyId)) {
        throw new Error(`Identifiant de cle invalide : ${keyId}`);
      }
      if (key.length !== 32) {
        throw new Error(`Cle ${keyId} invalide : ${key.length} octets au lieu de 32`);
      }
    }
    FieldCipher.currentKeyId = currentKeyId;
    FieldCipher.keys = new Map(keys);
  }

  /** Uniquement pour les tests : rend le chiffrement de nouveau indisponible. */
  static forgetKey(): void {
    FieldCipher.currentKeyId = null;
    FieldCipher.keys.clear();
  }

  static get ready(): boolean {
    return FieldCipher.currentKeyId !== null;
  }

  static encrypt(value: string | null, context = ''): string | null {
    if (value === null || value === undefined) return null;

    const keyId = FieldCipher.currentKeyId;
    const key = keyId ? FieldCipher.keys.get(keyId) : undefined;
    if (!keyId || !key) {
      throw new Error(
        'Chiffrement indisponible : aucune cle installee. ' +
          'Ecrire en clair reviendrait a croire la base protegee sans qu elle le soit.',
      );
    }

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);

    return (
      `${PREFIX}.${keyId}.` +
      Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')
    );
  }

  static decrypt(stored: string | null, context = ''): string | null {
    if (stored === null || stored === undefined) return null;
    const match = /^enc\.v1\.([A-Za-z0-9_-]{1,32})\.([A-Za-z0-9_-]+)$/.exec(stored);
    if (!match) {
      throw new Error(
        'Valeur sensible non chiffree refusee : un retour au clair constituerait un downgrade',
      );
    }

    const [, keyId, payload] = match;
    const key = FieldCipher.keys.get(keyId);
    if (!key) {
      throw new Error(`Dechiffrement impossible : cle ${keyId} absente du keyring`);
    }

    const raw = Buffer.from(payload, 'base64url');
    if (raw.length < IV_BYTES + TAG_BYTES) {
      throw new Error('Valeur chiffree invalide : charge utile tronquee');
    }
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(context, 'utf8'));
    // L'etiquette d'authentification fait echouer le dechiffrement si le chiffre
    // a ete altere : le mode GCM detecte la falsification, il ne la subit pas.
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  /**
   * Lit exclusivement l'ancien format local `enc.v1.<payload>`.
   *
   * Reserve a la migration vers le keyring. Le chemin applicatif normal ne
   * l'accepte jamais, afin de ne pas recreer un downgrade sans identifiant.
   */
  static decryptLegacyV1(stored: string, context: string, legacyKey: Buffer): string {
    const match = /^enc\.v1\.([A-Za-z0-9_-]+)$/.exec(stored);
    if (!match || legacyKey.length !== 32) throw new Error('Ancien chiffre v1 illisible');

    const raw = Buffer.from(match[1], 'base64url');
    if (raw.length < IV_BYTES + TAG_BYTES) {
      throw new Error('Valeur chiffree invalide : charge utile tronquee');
    }
    const decipher = createDecipheriv('aes-256-gcm', legacyKey, raw.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  }
}

/**
 * Transformateur TypeORM : chiffre a l'ecriture, dechiffre a la lecture.
 *
 * Sa transparence est ce qui rend le chiffrement compatible avec les preuves
 * deja publiees. Le document XML canonique est construit depuis l'entite, donc
 * depuis le **clair** : les empreintes scellees ne bougent pas d'un octet.
 */
export const encryptedColumn = (context: string) => ({
  to: (value: string | null): string | null => FieldCipher.encrypt(value, context),
  from: (value: string | null): string | null => FieldCipher.decrypt(value, context),
});
