import { isMonetaryAmount } from './is-monetary-amount.validator';

describe('isMonetaryAmount', () => {
  it.each([1250.75, 0.01, 1, 999999999.99, 100.5])('accepte le montant %p', (amount) => {
    expect(isMonetaryAmount(amount)).toBe(true);
  });

  it('rejette un montant nul ou negatif', () => {
    expect(isMonetaryAmount(0)).toBe(false);
    expect(isMonetaryAmount(-10)).toBe(false);
  });

  it('rejette un montant en dessous du minimum de facturation', () => {
    expect(isMonetaryAmount(0.009)).toBe(false);
  });

  it('rejette plus de deux decimales', () => {
    expect(isMonetaryAmount(10.123)).toBe(false);
    expect(isMonetaryAmount(0.005)).toBe(false);
  });

  it('respecte un nombre de decimales configure', () => {
    expect(isMonetaryAmount(10.12345, { maxDecimals: 5 })).toBe(true);
    expect(isMonetaryAmount(10.123456, { maxDecimals: 5 })).toBe(false);
  });

  it('respecte un minimum configure', () => {
    expect(isMonetaryAmount(5, { min: 10 })).toBe(false);
    expect(isMonetaryAmount(10, { min: 10 })).toBe(true);
  });

  it.each([
    ['chaine numerique', '1250.75'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['null', null],
    ['undefined', undefined],
    ['objet', { amount: 10 }],
  ])('rejette une entree non numerique : %s', (_cas, value) => {
    expect(isMonetaryAmount(value)).toBe(false);
  });
});
