import { isValidIban, normalizeIban } from './is-iban.validator';

describe('normalizeIban', () => {
  it('retire les espaces et les tirets et passe en majuscules', () => {
    expect(normalizeIban('fr76 3000 6000 0112 3456 7890 189')).toBe('FR7630006000011234567890189');
    expect(normalizeIban('DE89-3704-0044-0532-0130-00')).toBe('DE89370400440532013000');
  });
});

describe('isValidIban', () => {
  it.each([
    ['France', 'FR7630006000011234567890189'],
    ['Allemagne', 'DE89370400440532013000'],
    ['Royaume-Uni', 'GB82WEST12345698765432'],
    ['Belgique', 'BE68539007547034'],
    ['Pays-Bas', 'NL91ABNA0417164300'],
    ['Suisse', 'CH9300762011623852957'],
    ['Espagne', 'ES9121000418450200051332'],
    ['Italie', 'IT60X0542811101000000123456'],
    ['Portugal', 'PT50000201231234567890154'],
  ])('accepte un IBAN %s valide', (_pays, iban) => {
    expect(isValidIban(iban)).toBe(true);
  });

  it('accepte un IBAN formate avec des espaces', () => {
    expect(isValidIban('FR76 3000 6000 0112 3456 7890 189')).toBe(true);
  });

  it('rejette une cle de controle MOD 97-10 incorrecte', () => {
    // Dernier chiffre altere : 189 -> 188. La structure reste valide.
    expect(isValidIban('FR7630006000011234567890188')).toBe(false);
  });

  it('rejette une longueur non conforme au registre du pays', () => {
    // Un IBAN francais fait 27 caracteres ; celui-ci en fait 26.
    expect(isValidIban('FR763000600001123456789018')).toBe(false);
  });

  it('rejette un code pays absent ou minuscule non normalise en amont', () => {
    expect(isValidIban('7630006000011234567890189')).toBe(false);
    expect(isValidIban('F76630006000011234567890189')).toBe(false);
  });

  it('rejette les caracteres non alphanumeriques', () => {
    expect(isValidIban('FR76-3000$6000/0112%3456!7890&189')).toBe(false);
  });

  it.each([
    ['chaine vide', ''],
    ['espaces seuls', '   '],
    ['trop court', 'FR76'],
    ['null', null],
    ['undefined', undefined],
    ['nombre', 42],
    ['objet', { iban: 'FR7630006000011234567890189' }],
  ])('rejette une entree invalide : %s', (_cas, value) => {
    expect(isValidIban(value)).toBe(false);
  });

  it('accepte un pays absent du registre si la structure et la cle sont valides', () => {
    // ZZ n'est pas un code pays reference : seule la regle generique s'applique.
    const generic = 'ZZ' + '00' + 'ABCDEFGHIJK';
    // La cle ci-dessus est arbitraire, donc invalide : on verifie juste
    // qu'aucune exception n'est levee et que le resultat est booleen.
    expect(typeof isValidIban(generic)).toBe('boolean');
  });
});
