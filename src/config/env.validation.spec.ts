import { validateEnv } from './env.validation';
import { LOCAL_SECURITY_MASTER_KEY } from '../security/key-derivation';

const validConfig = (overrides: Record<string, string> = {}): Record<string, string> => ({
  NODE_ENV: 'test',
  DB_HOST: 'localhost',
  DB_PORT: '5432',
  DB_USERNAME: 'banking',
  DB_PASSWORD: 'banking',
  DB_NAME: 'banking_test',
  SOAP_ENDPOINT: 'https://example.test/soap',
  ...overrides,
});

const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const OWN_KEY = `0x${'11'.repeat(32)}`;

describe('validateEnv', () => {
  describe('cle d ancrage sur reseau public', () => {
    it('REFUSE la cle de developpement publique hors chaine locale', () => {
      // Le compte #0 d'Anvil est documente, cle privee comprise : ancrer avec
      // lui reviendrait a laisser quiconque publier nos preuves a notre place.
      expect(() =>
        validateEnv(
          validConfig({ BLOCKCHAIN_CHAIN_ID: '11155111', BLOCKCHAIN_PRIVATE_KEY: ANVIL_KEY }),
        ),
      ).toThrow(/cle de developpement publique/);
    });

    it('REFUSE aussi lorsque la cle est simplement absente', () => {
      // L'oubli est le cas le plus probable, et le plus dangereux : la valeur
      // par defaut est precisement cette cle publique.
      const config = validConfig({ BLOCKCHAIN_CHAIN_ID: '11155111' });
      delete config.BLOCKCHAIN_PRIVATE_KEY;

      expect(() => validateEnv(config)).toThrow(/cle de developpement publique/);
    });

    it('tolere cette cle sur une chaine locale jetable', () => {
      expect(() =>
        validateEnv(
          validConfig({ BLOCKCHAIN_CHAIN_ID: '31337', BLOCKCHAIN_PRIVATE_KEY: ANVIL_KEY }),
        ),
      ).not.toThrow();
    });

    it('accepte un reseau public muni d une cle propre', () => {
      expect(() =>
        validateEnv(
          validConfig({ BLOCKCHAIN_CHAIN_ID: '11155111', BLOCKCHAIN_PRIVATE_KEY: OWN_KEY }),
        ),
      ).not.toThrow();
    });

    it('ne s applique pas quand l ancrage est desactive', () => {
      // Sans publication, aucune signature : la cle n a alors aucun role.
      expect(() =>
        validateEnv(
          validConfig({
            BLOCKCHAIN_CHAIN_ID: '11155111',
            BLOCKCHAIN_ENABLED: 'false',
            BLOCKCHAIN_PRIVATE_KEY: ANVIL_KEY,
          }),
        ),
      ).not.toThrow();
    });
  });

  it.each(['1', '1.5', '-0.01'])('refuse un taux de commission invalide (%s)', (feeRate) => {
    expect(() => validateEnv(validConfig({ MOBILE_MONEY_FEE_RATE: feeRate }))).toThrow(
      /MOBILE_MONEY_FEE_RATE/,
    );
  });

  it.each([
    ['MOBILE_MONEY_BANK_WORKER_INTERVAL_MS', '99'],
    ['MOBILE_MONEY_BANK_WORKER_MAX_ATTEMPTS', '0'],
    ['MOBILE_MONEY_BANK_WORKER_ENABLED', 'peut-etre'],
  ])('refuse une configuration invalide du travailleur (%s)', (key, value) => {
    expect(() => validateEnv(validConfig({ [key]: value }))).toThrow(key);
  });

  it.each(['0', '0.015', '0.999'])('accepte un taux de commission valide (%s)', (feeRate) => {
    expect(validateEnv(validConfig({ MOBILE_MONEY_FEE_RATE: feeRate }))).toMatchObject({
      MOBILE_MONEY_FEE_RATE: feeRate,
    });
  });

  it.each(['secret-court', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'])(
    'refuse une cle non Base64-32-octets sans la divulguer',
    (masterKey) => {
      expect(() => validateEnv(validConfig({ SECURITY_MASTER_KEY: masterKey }))).toThrow(
        /SECURITY_MASTER_KEY.*valeur masquee/,
      );
    },
  );

  it('refuse la cle de demonstration en production', () => {
    const config = validConfig({
      NODE_ENV: 'production',
      AUTH_ENABLED: 'true',
      API_KEYS: 'cle-de-test',
      MOBILE_MONEY_WEBHOOK_SECRET: 'secret-webhook-explicite',
      SECURITY_CURRENT_KEY_ID: 'local-v1',
      SECURITY_MASTER_KEY: LOCAL_SECURITY_MASTER_KEY,
    });

    expect(() => validateEnv(config)).toThrow(/SECURITY_MASTER_KEY.*production/);
  });

  it('accepte une cle Base64 representant exactement 32 octets', () => {
    const masterKey = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1)).toString(
      'base64',
    );
    expect(validateEnv(validConfig({ SECURITY_MASTER_KEY: masterKey }))).toMatchObject({
      SECURITY_MASTER_KEY: masterKey,
    });
  });

  it('refuse une cle Base64 manifestement sans entropie', () => {
    const repeated = Buffer.alloc(32, 0x61).toString('base64');

    expect(() => validateEnv(validConfig({ SECURITY_MASTER_KEY: repeated }))).toThrow(
      /entropie.*valeur masquee/,
    );
  });

  it('refuse un keyring ambigu sans exposer les cles', () => {
    const encoded = Buffer.alloc(32, 9).toString('base64');
    expect(() =>
      validateEnv(
        validConfig({
          SECURITY_CURRENT_KEY_ID: 'key-v2',
          SECURITY_PREVIOUS_KEYS: `key-v2|${encoded}`,
        }),
      ),
    ).toThrow(/SECURITY_PREVIOUS_KEYS.*masquees/);
  });
});
