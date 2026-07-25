import type { SoapFaultDetails } from '../soap.types';

/** Erreur de base de la couche d'integration SOAP. */
export abstract class SoapIntegrationException extends Error {
  protected constructor(
    message: string,
    readonly operation: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

/**
 * Le service distant a repondu, mais avec une enveloppe `<soap:Fault>`.
 * Cas fonctionnel cote fournisseur : l'appel a abouti, le traitement a echoue.
 */
export class SoapFaultException extends SoapIntegrationException {
  constructor(
    readonly fault: SoapFaultDetails,
    operation: string,
    readonly rawResponse?: string,
  ) {
    super(`Faute SOAP sur l'operation ${operation} : ${fault.faultString}`, operation);
  }
}

/**
 * L'echange n'a pas pu aboutir : DNS, TCP, TLS, timeout, code HTTP non 2xx
 * sans enveloppe exploitable.
 */
export class SoapCommunicationException extends SoapIntegrationException {
  constructor(
    message: string,
    operation: string,
    readonly timedOut = false,
    cause?: unknown,
    readonly attempts = 1,
  ) {
    super(message, operation, cause);
  }
}

/**
 * La reponse a ete recue mais est inexploitable : XML malforme, enveloppe
 * inattendue, element de resultat absent, ou payload rejete par les gardes
 * de securite du parseur (DOCTYPE/ENTITY, taille excessive).
 */
export class SoapParsingException extends SoapIntegrationException {
  constructor(message: string, operation: string, cause?: unknown) {
    super(message, operation, cause);
  }
}
