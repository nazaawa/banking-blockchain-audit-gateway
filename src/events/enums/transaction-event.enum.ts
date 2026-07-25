/**
 * Faits metier consignes dans le registre append-only.
 *
 * Un evenement decrit **ce qui s'est produit**, jamais l'etat courant. C'est la
 * difference de fond avec le scellement d'instantane : celui-ci prouve « voici a
 * quoi la ligne ressemble », un registre d'evenements prouve « voici la suite
 * des faits ». Seul le second permet d'opposer un historique.
 */
export enum TransactionEventType {
  // --- Virement classique ---------------------------------------------------
  TRANSFER_INITIATED = 'TRANSFER_INITIATED',
  TRANSFER_COMPLETED = 'TRANSFER_COMPLETED',
  TRANSFER_FAILED = 'TRANSFER_FAILED',

  // --- Mobile Money : jambe fournisseur -------------------------------------
  PAYMENT_INITIATED = 'PAYMENT_INITIATED',
  PROVIDER_CONFIRMED = 'PROVIDER_CONFIRMED',
  PROVIDER_FAILED = 'PROVIDER_FAILED',

  /** Le montant ou la devise notifie diverge de la commande. */
  AMOUNT_MISMATCH_DETECTED = 'AMOUNT_MISMATCH_DETECTED',

  // --- Mobile Money : jambe bancaire ----------------------------------------
  BANK_PROCESSING_BLOCKED = 'BANK_PROCESSING_BLOCKED',
  BANK_PROCESSING_COMPLETED = 'BANK_PROCESSING_COMPLETED',
  BANK_PROCESSING_FAILED = 'BANK_PROCESSING_FAILED',

  // --- Rapprochement --------------------------------------------------------
  RECONCILIATION_MATCHED = 'RECONCILIATION_MATCHED',
  RECONCILIATION_MISMATCH = 'RECONCILIATION_MISMATCH',

  // --- Dossier d'exception --------------------------------------------------
  CASE_OPENED = 'CASE_OPENED',
  CASE_RESOLVED = 'CASE_RESOLVED',
  /** Preuve de synthese : cloture du dossier (phase 4). */
  CASE_CLOSED = 'CASE_CLOSED',

  // --- Remboursement (phase 3) ----------------------------------------------
  REFUND_REQUESTED = 'REFUND_REQUESTED',
  /** Dossier rouvert apres un refus metier resolu hors systeme. */
  REFUND_REOPENED = 'REFUND_REOPENED',
  REFUND_COMPLETED = 'REFUND_COMPLETED',
  REFUND_FAILED = 'REFUND_FAILED',

  /** Rapatriement des fonds de l'agregateur vers le compte de reglement. */
  SETTLEMENT_SWEPT = 'SETTLEMENT_SWEPT',
}

/**
 * Evenements qui closent le dossier.
 *
 * Declares des maintenant pour que le type PostgreSQL n'ait pas a etre modifie
 * lorsque les phases suivantes les emettront.
 */
export const CLOSING_EVENT_TYPES: ReadonlySet<TransactionEventType> = new Set([
  TransactionEventType.CASE_CLOSED,
]);
