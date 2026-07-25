/** Issue d'une demande de remboursement aupres du fournisseur. */
export interface ProviderRefundResult {
  /** Reference du remboursement cote fournisseur, a conserver pour le rapprochement. */
  providerRefundReference: string;
  /** `true` si le fournisseur a repris la demande d'un envoi anterieur. */
  deduplicated: boolean;
}

/** Le fournisseur a refuse la demande pour un motif metier : rejouer n'aidera pas. */
export class ProviderRefundRejectedException extends Error {
  constructor(readonly reason: string) {
    super(`Remboursement refuse par le fournisseur : ${reason}`);
    this.name = 'ProviderRefundRejectedException';
  }
}

/** L'echange n'a pas abouti : l'issue reelle est inconnue, un rejeu est requis. */
export class ProviderRefundUnavailableException extends Error {
  constructor(readonly reason: string) {
    super(`Fournisseur injoignable pour le remboursement : ${reason}`);
    this.name = 'ProviderRefundUnavailableException';
  }
}

export const PROVIDER_REFUND_PORT = Symbol('PROVIDER_REFUND_PORT');

/**
 * Contrat de remboursement cote fournisseur.
 *
 * ## Pourquoi la cle d'idempotence est dans la signature
 *
 * Si l'echange se coupe apres l'envoi mais avant la reponse, la passerelle ne
 * peut pas savoir si le remboursement a ete pris en compte. Rejouer a l'aveugle
 * risquerait de rembourser deux fois ; ne pas rejouer laisserait le payeur sans
 * son argent. Aucune des deux issues n'est acceptable.
 *
 * La cle est donc generee une seule fois, persistee, et transmise a chaque
 * tentative. C'est au fournisseur de dedupliquer — exactement ce que la
 * passerelle exige elle-meme de ses propres appelants.
 */
export interface ProviderRefundPort {
  refund(request: {
    idempotencyKey: string;
    providerReference: string;
    amount: number;
    currency: string;
  }): Promise<ProviderRefundResult>;
}
