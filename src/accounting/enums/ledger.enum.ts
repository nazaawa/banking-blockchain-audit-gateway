/**
 * Plan de comptes.
 *
 * Le ledger ne modelise que ce dont la passerelle a la **garde**. C'est pourquoi
 * le virement classique n'y figure pas : il instruit la banque sans jamais
 * detenir de fonds, il n'y a donc rien a comptabiliser.
 */
export enum LedgerAccount {
  /** Fonds encaisses et detenus chez l'agregateur Mobile Money. */
  PROVIDER_FLOAT = 'PROVIDER_FLOAT',
  /** Compte bancaire de la passerelle, alimente par rapatriement. */
  SETTLEMENT = 'SETTLEMENT',
  /** Du au beneficiaire tant que l'instruction bancaire n'a pas abouti. */
  CREDITOR_PAYABLE = 'CREDITOR_PAYABLE',
  /** Du au payeur : dette nee d'un ecart ou d'un echec apres encaissement. */
  PAYER_PAYABLE = 'PAYER_PAYABLE',
  /** Commission retenue par la passerelle sur un service effectivement rendu. */
  FEE_REVENUE = 'FEE_REVENUE',
}

/** Nature d'un compte : fixe le sens dans lequel son solde augmente. */
export enum AccountKind {
  ASSET = 'ASSET',
  LIABILITY = 'LIABILITY',
  REVENUE = 'REVENUE',
}

export const ACCOUNT_KINDS: Readonly<Record<LedgerAccount, AccountKind>> = {
  [LedgerAccount.PROVIDER_FLOAT]: AccountKind.ASSET,
  [LedgerAccount.SETTLEMENT]: AccountKind.ASSET,
  [LedgerAccount.CREDITOR_PAYABLE]: AccountKind.LIABILITY,
  [LedgerAccount.PAYER_PAYABLE]: AccountKind.LIABILITY,
  [LedgerAccount.FEE_REVENUE]: AccountKind.REVENUE,
};

export enum EntryDirection {
  DEBIT = 'DEBIT',
  CREDIT = 'CREDIT',
}

/**
 * Solde d'un compte, exprime dans le sens ou il augmente.
 *
 * Un actif croit au debit, un passif et un produit au credit. Rendre un solde
 * de passif negatif parce qu'il est credite serait exact au signe pres, mais
 * illisible pour qui lit « ce que nous devons ».
 */
export const balanceOf = (account: LedgerAccount, debits: number, credits: number): number =>
  ACCOUNT_KINDS[account] === AccountKind.ASSET ? debits - credits : credits - debits;
