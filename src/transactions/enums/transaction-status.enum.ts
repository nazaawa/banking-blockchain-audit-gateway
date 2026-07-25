/** Cycle de vie d'une demande de virement. */
export enum TransactionStatus {
  /** Demande recue, validee et enregistree. Aucun appel externe encore emis. */
  PENDING = 'PENDING',
  /** Appel au service externe en cours. */
  PROCESSING = 'PROCESSING',
  /** Enrichissement termine : la transaction est complete et consultable. */
  COMPLETED = 'COMPLETED',
  /** L'echange externe a echoue (faute SOAP, timeout, reponse inexploitable). */
  FAILED = 'FAILED',
}

/** Etats a partir desquels aucune transition n'est plus possible. */
export const TERMINAL_STATUSES: ReadonlySet<TransactionStatus> = new Set([
  TransactionStatus.COMPLETED,
  TransactionStatus.FAILED,
]);
