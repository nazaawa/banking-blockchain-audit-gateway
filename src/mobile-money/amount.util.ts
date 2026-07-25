/**
 * Comparaison de montants monetaires.
 *
 * Source unique pour les deux points de controle du flux Mobile Money :
 *  - le garde-fou qui precede l'instruction bancaire ;
 *  - le rapprochement final.
 *
 * Les faire diverger serait un defaut en soi : un ecart accepte en amont mais
 * signale en aval laisserait passer un mouvement de fonds que l'on refuserait
 * ensuite de rapprocher.
 */

/**
 * Convertit en unites mineures (centimes) pour comparer sans piege de binaire
 * flottant : `0.1 + 0.2 !== 0.3`, mais `10 + 20 === 30`.
 */
export function toMinorUnits(amount: number | null | undefined): number | null {
  if (amount === null || amount === undefined) return null;
  const parsed = Number(amount);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

/** Egalite stricte de deux montants, au centime pres. */
export function amountsMatch(
  left: number | null | undefined,
  right: number | null | undefined,
): boolean {
  const a = toMinorUnits(left);
  const b = toMinorUnits(right);
  return a !== null && b !== null && a === b;
}

/** Egalite de devises, insensible a la casse et aux espaces parasites. */
export function currenciesMatch(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) return false;
  return left.trim().toUpperCase() === right.trim().toUpperCase();
}
