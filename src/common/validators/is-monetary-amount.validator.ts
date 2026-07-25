import {
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  registerDecorator,
} from 'class-validator';

export interface MonetaryAmountOptions {
  /** Nombre maximum de decimales autorisees (defaut : 2). */
  maxDecimals?: number;
  /** Montant minimum strictement requis (defaut : 0.01). */
  min?: number;
}

/** Verifie qu'un nombre est un montant monetaire strictement positif et correctement arrondi. */
export function isMonetaryAmount(value: unknown, options: MonetaryAmountOptions = {}): boolean {
  const { maxDecimals = 2, min = 0.01 } = options;

  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (value < min) return false;

  // Comparaison sur la representation decimale : evite les pieges du binaire flottant.
  const decimals = value.toString().split('.')[1]?.length ?? 0;
  return decimals <= maxDecimals;
}

@ValidatorConstraint({ name: 'isMonetaryAmount', async: false })
export class IsMonetaryAmountConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    return isMonetaryAmount(value, (args.constraints[0] ?? {}) as MonetaryAmountOptions);
  }

  defaultMessage(args: ValidationArguments): string {
    const { maxDecimals = 2, min = 0.01 } = (args.constraints[0] ?? {}) as MonetaryAmountOptions;
    return `${args.property} doit etre un montant >= ${min} avec au plus ${maxDecimals} decimales`;
  }
}

/** Valide un montant monetaire : positif, fini, et limite a N decimales. */
export function IsMonetaryAmount(
  options: MonetaryAmountOptions = {},
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isMonetaryAmount',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [options],
      validator: IsMonetaryAmountConstraint,
    });
  };
}
