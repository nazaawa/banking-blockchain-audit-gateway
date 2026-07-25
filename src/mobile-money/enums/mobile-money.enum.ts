/** Operateurs exposes par le simulateur d'agregateur. */
export enum MobileMoneyOperator {
  MPESA = 'MPESA',
  AIRTEL_MONEY = 'AIRTEL_MONEY',
  ORANGE_MONEY = 'ORANGE_MONEY',
}

/** Etat du paiement chez l'agregateur Mobile Money. */
export enum MobileMoneyStatus {
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
}

/** Verdict du rapprochement entre l'agregateur et le back-office bancaire. */
export enum ReconciliationStatus {
  PENDING = 'PENDING',
  MATCHED = 'MATCHED',
  MISMATCH = 'MISMATCH',
  MANUAL_REVIEW = 'MANUAL_REVIEW',
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
