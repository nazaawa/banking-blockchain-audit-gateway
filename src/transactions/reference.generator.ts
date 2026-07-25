import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

/** `TRF-` + date (8) + `-` + 8 caracteres alphanumeriques = 21 caracteres. */
export const REFERENCE_PATTERN = /^TRF-\d{8}-[0-9A-HJ-NP-Z]{8}$/;

/**
 * Alphabet Crockford base32 : chiffres et majuscules sans I, L, O ni U.
 * Evite les confusions a la lecture ou a la dictee d'une reference bancaire.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Genere les references fonctionnelles de virement.
 *
 * Format : `TRF-20260725-8F3A2C71`
 *  - prefixe metier lisible ;
 *  - date d'emission (UTC) pour un tri et un archivage naturels ;
 *  - 8 caracteres tires du CSPRNG, soit 32^8 ≈ 1,1 x 10^12 combinaisons par jour.
 *
 * L'unicite reelle reste garantie par la contrainte `UNIQUE` en base : le
 * service rejoue la generation en cas de collision.
 */
@Injectable()
export class ReferenceGenerator {
  generate(now: Date = new Date()): string {
    return `TRF-${this.formatDate(now)}-${this.randomSuffix(8)}`;
  }

  private formatDate(date: Date): string {
    const year = date.getUTCFullYear().toString().padStart(4, '0');
    const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
    const day = date.getUTCDate().toString().padStart(2, '0');
    return `${year}${month}${day}`;
  }

  /** Tirage sans biais modulo : l'alphabet fait 32 caracteres, soit 5 bits exacts. */
  private randomSuffix(length: number): string {
    const bytes = randomBytes(length);
    let suffix = '';
    for (const byte of bytes) {
      suffix += ALPHABET[byte & 0x1f];
    }
    return suffix;
  }
}
