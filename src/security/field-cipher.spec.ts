import { randomBytes } from 'node:crypto';
import { FieldCipher } from './field-cipher';

describe('FieldCipher', () => {
  beforeEach(() => {
    FieldCipher.useKey(randomBytes(32));
  });

  afterEach(() => {
    FieldCipher.forgetKey();
  });

  it('chiffre de maniere non deterministe puis restitue le clair', () => {
    const first = FieldCipher.encrypt('FR7630006000011234567890189', 'transactions.debtor_iban');
    const second = FieldCipher.encrypt('FR7630006000011234567890189', 'transactions.debtor_iban');

    expect(first).toMatch(/^enc\.v1\./);
    expect(second).not.toBe(first);
    expect(FieldCipher.decrypt(first, 'transactions.debtor_iban')).toBe(
      'FR7630006000011234567890189',
    );
  });

  it('refuse un chiffre deplace vers une autre colonne', () => {
    const stored = FieldCipher.encrypt('DE89370400440532013000', 'transactions.creditor_iban');

    expect(() => FieldCipher.decrypt(stored, 'transactions.debtor_iban')).toThrow();
  });

  it('detecte une charge utile tronquee', () => {
    expect(() => FieldCipher.decrypt('enc.v1.test.AQID', 'transactions.debtor_iban')).toThrow(
      /tronquee/,
    );
  });

  it('refuse d ecrire si la cle n est pas installee', () => {
    FieldCipher.forgetKey();

    expect(() => FieldCipher.encrypt('secret', 'transactions.debtor_iban')).toThrow(
      /aucune cle installee/,
    );
  });

  it('refuse une valeur en clair pour bloquer tout downgrade', () => {
    expect(() =>
      FieldCipher.decrypt('FR7630006000011234567890189', 'transactions.debtor_iban'),
    ).toThrow(/downgrade/);
  });

  it('lit une ancienne cle mais chiffre uniquement avec la cle courante', () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    FieldCipher.useKeyRing('key-2025', new Map([['key-2025', oldKey]]));
    const oldCiphertext = FieldCipher.encrypt('ACME GmbH', 'transactions.creditor_name');

    FieldCipher.useKeyRing(
      'key-2026',
      new Map([
        ['key-2026', newKey],
        ['key-2025', oldKey],
      ]),
    );
    const newCiphertext = FieldCipher.encrypt('ACME GmbH', 'transactions.creditor_name');

    expect(oldCiphertext).toMatch(/^enc\.v1\.key-2025\./);
    expect(newCiphertext).toMatch(/^enc\.v1\.key-2026\./);
    expect(FieldCipher.decrypt(oldCiphertext, 'transactions.creditor_name')).toBe('ACME GmbH');
  });

  it('refuse un chiffre dont la cle a quitte le keyring', () => {
    FieldCipher.useKeyRing('old', new Map([['old', randomBytes(32)]]));
    const stored = FieldCipher.encrypt('ACME GmbH', 'transactions.creditor_name');
    FieldCipher.useKeyRing('new', new Map([['new', randomBytes(32)]]));

    expect(() => FieldCipher.decrypt(stored, 'transactions.creditor_name')).toThrow(
      /absente du keyring/,
    );
  });

  it('isole la lecture de l ancien format sans keyId au chemin de migration', () => {
    const legacyKey = randomBytes(32);
    FieldCipher.useKeyRing('legacy', new Map([['legacy', legacyKey]]));
    const currentFormat = FieldCipher.encrypt(
      'DE89370400440532013000',
      'transactions.creditor_iban',
    ) as string;
    const legacyFormat = currentFormat.replace('enc.v1.legacy.', 'enc.v1.');

    expect(() => FieldCipher.decrypt(legacyFormat, 'transactions.creditor_iban')).toThrow(
      /downgrade/,
    );
    expect(FieldCipher.decryptLegacyV1(legacyFormat, 'transactions.creditor_iban', legacyKey)).toBe(
      'DE89370400440532013000',
    );
  });
});
