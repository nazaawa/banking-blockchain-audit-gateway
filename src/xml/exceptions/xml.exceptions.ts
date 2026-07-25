/** Detail d'une erreur de validation XSD. */
export interface XsdViolation {
  line?: number;
  message: string;
}

/**
 * Le document XML produit ne respecte pas son schema.
 *
 * En amont de l'appel SOAP, c'est un rejet fonctionnel de la demande. Au moment
 * du scellement, c'est un defaut interne : le serialiseur a produit un document
 * non conforme, et la transaction ne doit pas etre scellee.
 */
export class XsdValidationException extends Error {
  constructor(
    readonly schemaName: string,
    readonly violations: XsdViolation[],
  ) {
    super(
      `Document XML non conforme au schema ${schemaName} : ` +
        violations.map((violation) => violation.message).join(' | '),
    );
    this.name = 'XsdValidationException';
  }
}

/** Le schema est introuvable ou illisible : defaut de deploiement. */
export class XsdSchemaNotFoundException extends Error {
  constructor(schemaName: string, searchedPath: string) {
    super(`Schema XSD introuvable : ${schemaName} (recherche dans ${searchedPath})`);
    this.name = 'XsdSchemaNotFoundException';
  }
}
