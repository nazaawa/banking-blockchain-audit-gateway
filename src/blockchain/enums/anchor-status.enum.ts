/** Etat de l'ancrage d'une transaction sur la blockchain. */
export enum AnchorStatus {
  /** Transaction non encore scellee (etat non terminal, ou ancrage desactive). */
  NOT_SEALED = 'NOT_SEALED',
  /** Empreinte calculee, en attente d'inclusion dans un lot. */
  PENDING = 'PENDING',
  /** Incluse dans un lot dont la racine est inscrite sur la chaine. */
  ANCHORED = 'ANCHORED',
  /** Le lot a echoue de facon definitive ; l'empreinte reste valable en base. */
  FAILED = 'FAILED',
}

/** Etat d'un lot d'ancrage. */
export enum BatchStatus {
  /** Lot constitue, racine calculee, transaction blockchain pas encore emise. */
  PENDING = 'PENDING',
  /** Transaction emise, en attente de confirmation. */
  ANCHORING = 'ANCHORING',
  /** Racine confirmee sur la chaine. */
  ANCHORED = 'ANCHORED',
  /** Echec definitif apres epuisement des reprises. */
  FAILED = 'FAILED',
}

/** Verdict d'un controle d'integrite. */
export enum IntegrityVerdict {
  /** Donnees intactes et preuve confirmee sur la chaine. */
  VERIFIED = 'VERIFIED',
  /** Donnees intactes, mais l'ancrage n'a pas encore eu lieu. */
  PENDING_ANCHOR = 'PENDING_ANCHOR',
  /** Les donnees en base ne correspondent plus a l'empreinte scellee. */
  TAMPERED = 'TAMPERED',
  /** Transaction jamais scellee : aucune preuve disponible. */
  NOT_SEALED = 'NOT_SEALED',
  /** Verification hors chaine concluante, chaine injoignable. */
  CHAIN_UNAVAILABLE = 'CHAIN_UNAVAILABLE',
}
