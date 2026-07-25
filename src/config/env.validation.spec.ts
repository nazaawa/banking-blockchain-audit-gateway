import { validateEnv } from './env.validation';

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

describe('validateEnv', () => {
  it.each(['1', '1.5', '-0.01'])('refuse un taux de commission invalide (%s)', (feeRate) => {
    expect(() => validateEnv(validConfig({ MOBILE_MONEY_FEE_RATE: feeRate }))).toThrow(
      /MOBILE_MONEY_FEE_RATE/,
    );
  });

  it.each(['0', '0.015', '0.999'])('accepte un taux de commission valide (%s)', (feeRate) => {
    expect(validateEnv(validConfig({ MOBILE_MONEY_FEE_RATE: feeRate }))).toMatchObject({
      MOBILE_MONEY_FEE_RATE: feeRate,
    });
  });

  it('refuse une cle maitresse trop courte sans la divulguer', () => {
    expect(() => validateEnv(validConfig({ SECURITY_MASTER_KEY: 'secret-court' }))).toThrow(
      /SECURITY_MASTER_KEY.*valeur masquee/,
    );
  });

  it('refuse la cle de demonstration en production', () => {
    const config = validConfig({
      NODE_ENV: 'production',
      AUTH_ENABLED: 'true',
      API_KEYS: 'cle-de-test',
      MOBILE_MONEY_WEBHOOK_SECRET: 'secret-webhook-explicite',
      SECURITY_MASTER_KEY: 'local-demo-master-key-a-remplacer',
    });

    expect(() => validateEnv(config)).toThrow(/SECURITY_MASTER_KEY.*production/);
  });
});
