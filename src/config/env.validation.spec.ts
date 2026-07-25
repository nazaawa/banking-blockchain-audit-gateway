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
});
