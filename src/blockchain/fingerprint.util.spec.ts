import { computeFingerprint, generateSalt, toLeaf, uuidToBytes32 } from './fingerprint.util';

const HEX32 = /^0x[0-9a-f]{64}$/;
const DOCUMENT = '<TransferRecord><reference>TRF-20260725-8F3A2C71</reference></TransferRecord>';

describe('generateSalt', () => {
  it('produit 32 octets hexadecimaux', () => {
    expect(generateSalt()).toMatch(HEX32);
  });

  it('ne se repete pas', () => {
    const salts = new Set(Array.from({ length: 5000 }, () => generateSalt()));
    expect(salts.size).toBe(5000);
  });
});

describe('computeFingerprint', () => {
  it('est deterministe a sel et document constants', () => {
    const salt = generateSalt();
    expect(computeFingerprint(salt, DOCUMENT)).toBe(computeFingerprint(salt, DOCUMENT));
  });

  it('change des qu un seul caractere du document change', () => {
    const salt = generateSalt();
    const altered = DOCUMENT.replace('8F3A2C71', '8F3A2C72');

    expect(computeFingerprint(salt, altered)).not.toBe(computeFingerprint(salt, DOCUMENT));
  });

  it('detecte la modification d un montant au centime pres', () => {
    const salt = generateSalt();
    const original = '<TransferRecord><amount>1250.75</amount></TransferRecord>';
    const tampered = '<TransferRecord><amount>1250.76</amount></TransferRecord>';

    expect(computeFingerprint(salt, tampered)).not.toBe(computeFingerprint(salt, original));
  });

  it('donne des empreintes distinctes pour un meme document sous deux sels', () => {
    // C'est la propriete qui protege de l attaque par force brute sur les
    // preimages : deux virements identiques n exposent pas le meme condensat.
    expect(computeFingerprint(generateSalt(), DOCUMENT)).not.toBe(
      computeFingerprint(generateSalt(), DOCUMENT),
    );
  });

  it('refuse un sel mal forme', () => {
    expect(() => computeFingerprint('0x1234', DOCUMENT)).toThrow(/32 octets/);
    expect(() => computeFingerprint('pas-un-sel', DOCUMENT)).toThrow(/32 octets/);
  });

  it('gere les caracteres non ASCII sans ambiguite', () => {
    const salt = generateSalt();
    const accents = '<TransferRecord><name>Société Générale</name></TransferRecord>';
    const sansAccents = '<TransferRecord><name>Societe Generale</name></TransferRecord>';

    expect(computeFingerprint(salt, accents)).toMatch(HEX32);
    expect(computeFingerprint(salt, accents)).not.toBe(computeFingerprint(salt, sansAccents));
  });
});

describe('toLeaf', () => {
  it('rehache l empreinte pour former la feuille', () => {
    const fingerprint = computeFingerprint(generateSalt(), DOCUMENT);
    const leaf = toLeaf(fingerprint);

    expect(leaf).toMatch(HEX32);
    // Le second hachage protege contre la confusion feuille / noeud interne.
    expect(leaf).not.toBe(fingerprint);
    expect(toLeaf(fingerprint)).toBe(leaf);
  });

  it('refuse une empreinte mal formee', () => {
    expect(() => toLeaf('0xabc')).toThrow(/32 octets/);
  });
});

describe('uuidToBytes32', () => {
  it('complete un UUID a gauche par des zeros', () => {
    expect(uuidToBytes32('b6f0c4a2-6a5f-4a13-9d2e-3f0c9e2a1b77')).toBe(
      '0x00000000000000000000000000000000b6f0c4a26a5f4a139d2e3f0c9e2a1b77',
    );
  });

  it('est injectif', () => {
    const a = uuidToBytes32('b6f0c4a2-6a5f-4a13-9d2e-3f0c9e2a1b77');
    const b = uuidToBytes32('b6f0c4a2-6a5f-4a13-9d2e-3f0c9e2a1b78');
    expect(a).not.toBe(b);
  });

  it('refuse un identifiant invalide', () => {
    expect(() => uuidToBytes32('pas-un-uuid')).toThrow(/invalide/);
    expect(() => uuidToBytes32('')).toThrow(/invalide/);
  });
});
