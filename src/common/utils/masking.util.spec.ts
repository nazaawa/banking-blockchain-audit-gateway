import {
  REDACTED,
  maskDeep,
  maskFreeText,
  maskIban,
  maskPartial,
  maskXml,
  truncate,
} from './masking.util';

const IBAN_FR = 'FR7630006000011234567890189';
const IBAN_DE = 'DE89370400440532013000';

describe('maskIban', () => {
  it('conserve le pays, la cle de controle et les 4 derniers caracteres', () => {
    expect(maskIban(IBAN_FR)).toBe('FR76****0189');
    expect(maskIban(IBAN_DE)).toBe('DE89****3000');
  });

  it('normalise les espaces avant de masquer', () => {
    expect(maskIban('FR76 3000 6000 0112 3456 7890 189')).toBe('FR76****0189');
  });

  it('caviarde integralement une valeur trop courte pour etre masquee sans fuite', () => {
    expect(maskIban('FR7630')).toBe(REDACTED);
  });
});

describe('maskPartial', () => {
  it('ne laisse apparaitre que les extremites', () => {
    expect(maskPartial('BNPAFRPPXXX')).toBe('BN****XX');
  });

  it('caviarde une valeur trop courte', () => {
    expect(maskPartial('AB')).toBe(REDACTED);
  });
});

describe('maskFreeText', () => {
  it('masque un IBAN noye dans du texte libre', () => {
    expect(maskFreeText(`Virement vers ${IBAN_DE} accepte`)).toBe(
      'Virement vers DE89****3000 accepte',
    );
  });

  it('masque les longues suites de chiffres', () => {
    expect(maskFreeText('carte 4111111111111111 refusee')).toBe('carte 4111****11 refusee');
  });

  it('laisse intact un texte sans donnee sensible', () => {
    expect(maskFreeText('Facture 2026-0042')).toBe('Facture 2026-0042');
  });
});

describe('maskDeep', () => {
  it('masque les IBAN et caviarde les secrets, quelle que soit la casse de la cle', () => {
    const masked = maskDeep({
      debtorIban: IBAN_FR,
      creditor_iban: IBAN_DE,
      creditorName: 'ACME GmbH',
      amount: 1250.75,
      Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9',
      password: 'hunter2',
      apiKey: 'sk-live-1234',
    }) as Record<string, unknown>;

    expect(masked.debtorIban).toBe('FR76****0189');
    expect(masked.creditor_iban).toBe('DE89****3000');
    expect(masked.creditorName).toBe('ACME GmbH');
    expect(masked.amount).toBe(1250.75);
    expect(masked.Authorization).toBe(REDACTED);
    expect(masked.password).toBe(REDACTED);
    expect(masked.apiKey).toBe(REDACTED);
  });

  it('parcourt les structures imbriquees', () => {
    const masked = maskDeep({
      payment: { parties: [{ iban: IBAN_FR }, { iban: IBAN_DE }] },
    }) as { payment: { parties: Array<{ iban: string }> } };

    expect(masked.payment.parties[0].iban).toBe('FR76****0189');
    expect(masked.payment.parties[1].iban).toBe('DE89****3000');
  });

  it('preserve les types primitifs et les valeurs nulles', () => {
    expect(maskDeep(null)).toBeNull();
    expect(maskDeep(undefined)).toBeUndefined();
    expect(maskDeep(42)).toBe(42);
    expect(maskDeep(true)).toBe(true);
  });

  it('borne la profondeur pour resister aux structures excessivement imbriquees', () => {
    let deep: Record<string, unknown> = { iban: IBAN_FR };
    for (let i = 0; i < 12; i += 1) deep = { nested: deep };

    expect(() => maskDeep(deep)).not.toThrow();
    expect(JSON.stringify(maskDeep(deep))).toContain('TRUNCATED');
  });

  it('borne le nombre d elements parcourus dans un tableau', () => {
    const masked = maskDeep(Array.from({ length: 40 }, () => ({ iban: IBAN_FR }))) as unknown[];

    expect(masked).toHaveLength(26);
    expect(masked[25]).toContain('15 elements supplementaires');
  });

  it('ne laisse jamais fuiter un IBAN complet, quel que soit le nom de la cle', () => {
    const masked = JSON.stringify(maskDeep({ champLibre: `compte ${IBAN_FR}` }));
    expect(masked).not.toContain(IBAN_FR);
  });
});

describe('maskXml', () => {
  it('masque le contenu des balises sensibles, avec ou sans prefixe de namespace', () => {
    const xml = `<Transfer><debtorIban>${IBAN_FR}</debtorIban><ns1:creditorIban>${IBAN_DE}</ns1:creditorIban><amount>1250.75</amount></Transfer>`;

    const masked = maskXml(xml);

    expect(masked).toContain('<debtorIban>FR76****0189</debtorIban>');
    expect(masked).toContain('<ns1:creditorIban>DE89****3000</ns1:creditorIban>');
    expect(masked).toContain('<amount>1250.75</amount>');
    expect(masked).not.toContain(IBAN_FR);
    expect(masked).not.toContain(IBAN_DE);
  });

  it('caviarde integralement un token, meme court', () => {
    expect(maskXml('<token>abc123</token>')).toBe(`<token>${REDACTED}</token>`);
  });

  it('masque aussi un IBAN place dans une balise non listee', () => {
    const masked = maskXml(`<commentaire>versement sur ${IBAN_FR}</commentaire>`);
    expect(masked).toBe('<commentaire>versement sur FR76****0189</commentaire>');
  });

  it('laisse intact un echange SOAP sans donnee sensible', () => {
    const xml = '<NumberToDollars><dNum>1250.75</dNum></NumberToDollars>';
    expect(maskXml(xml)).toBe(xml);
  });
});

describe('truncate', () => {
  it('laisse intacte une chaine plus courte que la limite', () => {
    expect(truncate('abcdef', 10)).toBe('abcdef');
  });

  it('signale explicitement la troncature et la taille d origine', () => {
    const result = truncate('a'.repeat(100), 10);
    expect(result.startsWith('aaaaaaaaaa...')).toBe(true);
    expect(result).toContain('100 caracteres au total');
  });

  it('retourne une chaine vide si la limite est nulle', () => {
    expect(truncate('abcdef', 0)).toBe('');
  });
});
