import { REFERENCE_PATTERN, ReferenceGenerator } from './reference.generator';

describe('ReferenceGenerator', () => {
  const generator = new ReferenceGenerator();

  it('respecte le format TRF-YYYYMMDD-XXXXXXXX', () => {
    expect(generator.generate()).toMatch(REFERENCE_PATTERN);
  });

  it('utilise la date UTC fournie', () => {
    // 23h30 UTC-? : on passe explicitement une date UTC pour eviter tout
    // decalage lie au fuseau de la machine de test.
    const reference = generator.generate(new Date(Date.UTC(2026, 6, 25, 23, 30)));
    expect(reference.startsWith('TRF-20260725-')).toBe(true);
  });

  it('complete la date sur 8 chiffres', () => {
    const reference = generator.generate(new Date(Date.UTC(2026, 0, 5)));
    expect(reference.startsWith('TRF-20260105-')).toBe(true);
  });

  it('n utilise pas les caracteres ambigus I, L, O et U', () => {
    const suffixes = Array.from({ length: 500 }, () => generator.generate().split('-')[2]).join('');
    expect(suffixes).not.toMatch(/[ILOU]/);
  });

  it('produit des references distinctes', () => {
    const references = new Set(Array.from({ length: 2000 }, () => generator.generate()));
    expect(references.size).toBe(2000);
  });

  it('a une longueur stable de 21 caracteres', () => {
    expect(generator.generate()).toHaveLength(21);
  });
});
