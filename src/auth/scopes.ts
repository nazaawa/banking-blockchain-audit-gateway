/**
 * Habilitations de l'API.
 *
 * Deliberement fines : le droit d'initier un virement et celui de rembourser
 * n'ont pas les memes consequences, et ne doivent pas etre portes par la meme
 * cle. Un compte d'integration marchand n'a aucune raison de pouvoir sortir des
 * fonds.
 */
export const SCOPES = {
  transfersRead: 'transfers:read',
  transfersWrite: 'transfers:write',
  /** Declenche un mouvement sortant : habilitation la plus sensible. */
  refundsWrite: 'refunds:write',
  refundsApprove: 'refunds:approve',
  reconciliationWrite: 'reconciliation:write',
  ledgerRead: 'ledger:read',
  treasuryWrite: 'treasury:write',
  anchorsRead: 'anchors:read',
  anchorsWrite: 'anchors:write',
  simulatorWrite: 'simulator:write',
} as const;

export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

export const ALL_SCOPES: readonly string[] = Object.values(SCOPES);
