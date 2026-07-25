import { amountsMatch, currenciesMatch, toMinorUnits } from './amount.util';

describe('toMinorUnits', () => {
  it('convertit en centimes', () => {
    expect(toMinorUnits(1250.75)).toBe(125075);
    expect(toMinorUnits(0.01)).toBe(1);
    expect(toMinorUnits(87450.09)).toBe(8745009);
  });

  it('retourne null pour une valeur absente ou non finie', () => {
    expect(toMinorUnits(null)).toBeNull();
    expect(toMinorUnits(undefined)).toBeNull();
    expect(toMinorUnits(Number.NaN)).toBeNull();
    expect(toMinorUnits(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('amountsMatch', () => {
  it('accepte deux ecritures du meme montant', () => {
    expect(amountsMatch(1250.7, 1250.7)).toBe(true);
    expect(amountsMatch(1250, 1250.0)).toBe(true);
  });

  it('refuse un ecart d un centime', () => {
    expect(amountsMatch(1250.75, 1250.76)).toBe(false);
  });

  it('refuse un ecart massif — le cas du paiement partiel', () => {
    expect(amountsMatch(1.0, 1250.75)).toBe(false);
  });

  it('resiste aux pieges du binaire flottant', () => {
    expect(amountsMatch(0.1 + 0.2, 0.3)).toBe(true);
  });

  it('refuse toute comparaison impliquant une valeur absente', () => {
    expect(amountsMatch(null, 10)).toBe(false);
    expect(amountsMatch(10, null)).toBe(false);
    expect(amountsMatch(null, null)).toBe(false);
  });
});

describe('currenciesMatch', () => {
  it('ignore la casse et les espaces', () => {
    expect(currenciesMatch('cdf', 'CDF')).toBe(true);
    expect(currenciesMatch(' EUR ', 'EUR')).toBe(true);
  });

  it('refuse deux devises distinctes', () => {
    expect(currenciesMatch('USD', 'CDF')).toBe(false);
  });

  it('refuse une devise absente', () => {
    expect(currenciesMatch(null, 'CDF')).toBe(false);
    expect(currenciesMatch('CDF', '')).toBe(false);
  });
});
