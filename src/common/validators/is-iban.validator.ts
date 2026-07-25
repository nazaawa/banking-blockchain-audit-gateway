import {
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  registerDecorator,
} from 'class-validator';

/**
 * Longueur totale de l'IBAN par code pays (registre ISO 13616).
 * Un pays absent de la table reste accepte si la structure generique et la
 * cle de controle mod-97 sont valides.
 */
const IBAN_LENGTH_BY_COUNTRY: Readonly<Record<string, number>> = {
  AD: 24,
  AE: 23,
  AL: 28,
  AT: 20,
  AZ: 28,
  BA: 20,
  BE: 16,
  BG: 22,
  BH: 22,
  BR: 29,
  BY: 28,
  CH: 21,
  CR: 22,
  CY: 28,
  CZ: 24,
  DE: 22,
  DK: 18,
  DO: 28,
  EE: 20,
  EG: 29,
  ES: 24,
  FI: 18,
  FO: 18,
  FR: 27,
  GB: 22,
  GE: 22,
  GI: 23,
  GL: 18,
  GR: 27,
  GT: 28,
  HR: 21,
  HU: 28,
  IE: 22,
  IL: 23,
  IQ: 23,
  IS: 26,
  IT: 27,
  JO: 30,
  KW: 30,
  KZ: 20,
  LB: 28,
  LC: 32,
  LI: 21,
  LT: 20,
  LU: 20,
  LV: 21,
  LY: 25,
  MC: 27,
  MD: 24,
  ME: 22,
  MK: 19,
  MR: 27,
  MT: 31,
  MU: 30,
  NL: 18,
  NO: 15,
  PK: 24,
  PL: 28,
  PS: 29,
  PT: 25,
  QA: 29,
  RO: 24,
  RS: 22,
  SA: 24,
  SC: 31,
  SE: 24,
  SI: 19,
  SK: 24,
  SM: 27,
  ST: 25,
  SV: 28,
  TL: 23,
  TN: 24,
  TR: 26,
  UA: 29,
  VA: 22,
  VG: 24,
  XK: 20,
};

/** Retire espaces et tirets, puis passe en majuscules. */
export function normalizeIban(value: string): string {
  return value.replace(/[\s-]/g, '').toUpperCase();
}

/**
 * Calcul de la cle de controle ISO 7064 MOD 97-10.
 * Le calcul est fait par blocs pour rester exact au-dela de Number.MAX_SAFE_INTEGER.
 */
function mod97(input: string): number {
  let remainder = 0;
  for (const char of input) {
    remainder = (remainder * 10 + Number.parseInt(char, 10)) % 97;
  }
  return remainder;
}

/** Verifie la structure, la longueur pays et la cle de controle d'un IBAN. */
export function isValidIban(value: unknown): boolean {
  if (typeof value !== 'string') return false;

  const iban = normalizeIban(value);

  // Structure generique : 2 lettres pays + 2 chiffres de controle + 11 a 30 alphanum.
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;

  const expectedLength = IBAN_LENGTH_BY_COUNTRY[iban.slice(0, 2)];
  if (expectedLength !== undefined && iban.length !== expectedLength) return false;

  // Deplace les 4 premiers caracteres en fin, puis convertit A-Z en 10-35.
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (char) => String(char.charCodeAt(0) - 55));

  return mod97(numeric) === 1;
}

@ValidatorConstraint({ name: 'isIban', async: false })
export class IsIbanConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isValidIban(value);
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} doit etre un IBAN valide (structure ISO 13616 et cle de controle MOD 97-10)`;
  }
}

/** Valide un IBAN : structure, longueur attendue pour le pays et cle de controle. */
export function IsIban(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isIban',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: IsIbanConstraint,
    });
  };
}
