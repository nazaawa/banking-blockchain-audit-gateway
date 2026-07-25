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
    expect(() => FieldCipher.decrypt('enc.v1.AQID', 'transactions.debtor_iban')).toThrow(
      /tronquee/,
    );
  });

  it('refuse d ecrire si la cle n est pas installee', () => {
    FieldCipher.forgetKey();

    expect(() => FieldCipher.encrypt('secret', 'transactions.debtor_iban')).toThrow(
      /aucune cle installee/,
    );
  });

  it('tolere une valeur heritee en clair', () => {
    expect(FieldCipher.decrypt('FR7630006000011234567890189', 'transactions.debtor_iban')).toBe(
      'FR7630006000011234567890189',
    );
  });
});
