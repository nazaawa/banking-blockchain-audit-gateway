import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Marqueur de version en tete de chaque valeur chiffree.
 *
 * Il remplit deux roles : distinguer un chiffre d'un clair herite, et permettre
 * une rotation d'algorithme sans ambiguite sur les donnees deja ecrites.
 */
const PREFIX = 'enc.v1.';

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
 * ## Le clair herite est tolere en lecture
 *
 * Les lignes anterieures au chiffrement ne portent pas de prefixe et sont
 * rendues telles quelles. Toute **ecriture** chiffre, y compris la reecriture
 * d'une ligne heritee. C'est un residu assume, non une porte laissee ouverte.
 */
export class FieldCipher {
  private static key: Buffer | null = null;

  /** Installe la cle resolue par la garde. Appele une fois, au demarrage. */
  static useKey(key: Buffer): void {
    if (key.length !== 32) {
      throw new Error(`Cle de chiffrement invalide : ${key.length} octets au lieu de 32`);
    }
    FieldCipher.key = key;
  }

  /** Uniquement pour les tests : rend le chiffrement de nouveau indisponible. */
  static forgetKey(): void {
    FieldCipher.key = null;
  }

  static get ready(): boolean {
    return FieldCipher.key !== null;
  }

  static encrypt(value: string | null, context = ''): string | null {
    if (value === null || value === undefined) return null;

    const key = FieldCipher.key;
    if (!key) {
      throw new Error(
        'Chiffrement indisponible : aucune cle installee. ' +
          'Ecrire en clair reviendrait a croire la base protegee sans qu elle le soit.',
      );
    }

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);

    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
  }

  static decrypt(stored: string | null, context = ''): string | null {
    if (stored === null || stored === undefined) return null;
    // Ligne anterieure au chiffrement : rendue telle quelle.
    if (!stored.startsWith(PREFIX)) return stored;

    const key = FieldCipher.key;
    if (!key) {
      throw new Error('Dechiffrement impossible : aucune cle installee');
    }

    const raw = Buffer.from(stored.slice(PREFIX.length), 'base64url');
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
