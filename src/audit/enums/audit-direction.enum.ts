/** Sens de l'echange consigne dans la piste d'audit. */
export enum AuditDirection {
  /** Requete SOAP emise par l'API vers le fournisseur. */
  OUTBOUND_REQUEST = 'OUTBOUND_REQUEST',
  /** Reponse SOAP nominale recue du fournisseur. */
  INBOUND_RESPONSE = 'INBOUND_RESPONSE',
  /** Enveloppe `<soap:Fault>` recue du fournisseur. */
  INBOUND_FAULT = 'INBOUND_FAULT',
  /** Echec de communication : aucune reponse exploitable. */
  COMMUNICATION_ERROR = 'COMMUNICATION_ERROR',
}

/** Issue de l'echange. */
export enum AuditOutcome {
  SUCCESS = 'SUCCESS',
  FAULT = 'FAULT',
  ERROR = 'ERROR',
}
