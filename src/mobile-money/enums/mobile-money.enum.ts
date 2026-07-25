/** Operateurs exposes par le simulateur d'agregateur. */
export enum MobileMoneyOperator {
  MPESA = 'MPESA',
  AIRTEL_MONEY = 'AIRTEL_MONEY',
  ORANGE_MONEY = 'ORANGE_MONEY',
}

/**
 * Etat de la jambe fournisseur : ce que l'agregateur a effectivement encaisse.
 *
 * Volontairement independant de l'issue du virement. Un paiement encaisse reste
 * `CONFIRMED` meme si l'instruction bancaire est ensuite refusee ou echoue :
 * confondre les deux effacerait le fait que le payeur a bien ete debite — et
 * donc l'obligation de remboursement qui en decoule.
 */
export enum ProviderStatus {
  INITIATED = 'INITIATED',
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  FAILED = 'FAILED',
}

/** Etat de l'instruction envoyee au back-office bancaire SOAP. */
export enum BankProcessingStatus {
  NOT_STARTED = 'NOT_STARTED',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  /**
   * Instruction volontairement non emise : un controle prealable l'a refusee.
   *
   * Se distingue de `NOT_STARTED` (rien ne s'est encore produit) et de `FAILED`
   * (la banque a ete sollicitee et a rejete). Ici la passerelle a decide de ne
   * pas solliciter la banque : c'est un refus assume, pas un incident subi.
   */
  BLOCKED = 'BLOCKED',
}

/** Verdict du rapprochement entre la jambe fournisseur et la jambe bancaire. */
export enum ReconciliationStatus {
  PENDING = 'PENDING',
  MATCHED = 'MATCHED',
  /** Divergence generique, constatee apres coup par le rapprochement. */
  MISMATCH = 'MISMATCH',
  /** Le montant notifie par le fournisseur differe du montant commande. */
  AMOUNT_MISMATCH = 'AMOUNT_MISMATCH',
  /** La devise notifiee par le fournisseur differe de la devise commandee. */
  CURRENCY_MISMATCH = 'CURRENCY_MISMATCH',
  /** Aucune jambe fournisseur encaissee : il n'y a rien a rapprocher. */
  NOT_APPLICABLE = 'NOT_APPLICABLE',
  MANUAL_REVIEW = 'MANUAL_REVIEW',
}

/**
 * Obligation de remboursement envers le payeur.
 *
 * Passe a `REQUIRED` des que le fournisseur a encaisse sans que le virement
 * aboutisse. Les etats suivants seront pilotes par le flux de remboursement.
 */
export enum RefundStatus {
  NOT_REQUIRED = 'NOT_REQUIRED',
  REQUIRED = 'REQUIRED',
  REQUESTED = 'REQUESTED',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

/**
 * Suivi du dossier d'exception.
 *
 * Distinct du rapprochement : celui-ci constate un fait, le dossier suit
 * l'action humaine que ce fait appelle.
 */
export enum CaseStatus {
  /** Aucune anomalie : rien a instruire. */
  NONE = 'NONE',
  MANUAL_REVIEW = 'MANUAL_REVIEW',
  RESOLVED = 'RESOLVED',
}

/** Nature fonctionnelle d'une ligne de la table historique `transactions`. */
export enum PaymentChannel {
  LEGACY_TRANSFER = 'LEGACY_TRANSFER',
  MOBILE_MONEY = 'MOBILE_MONEY',
}

/** Etats persistants d'un evenement webhook, utilises pour l'idempotence. */
export enum WebhookProcessingStatus {
  RECEIVED = 'RECEIVED',
  PROCESSING = 'PROCESSING',
  PROCESSED = 'PROCESSED',
  FAILED = 'FAILED',
}
