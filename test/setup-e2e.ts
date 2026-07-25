/**
 * Environnement des tests d'integration.
 *
 * Positionne avant tout chargement de `AppModule` : `dotenv` n'ecrase jamais
 * une variable deja presente dans `process.env`, ces valeurs ont donc priorite
 * sur le fichier `.env` du poste de developpement.
 *
 * Le client SOAP est remplace par un bouchon dans les specs : aucun appel
 * reseau n'est emis. Seule PostgreSQL est reellement sollicitee.
 */
process.env.NODE_ENV = 'test';
process.env.DB_NAME = process.env.DB_NAME_TEST ?? 'banking_soap_test';
process.env.DB_SYNCHRONIZE = 'true';
process.env.DB_LOGGING = 'false';
process.env.SWAGGER_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
process.env.ALLOWED_CURRENCIES = 'EUR,USD,GBP';
process.env.TRANSFER_MAX_AMOUNT = '1000000';
process.env.AUDIT_PERSIST_PAYLOADS = 'true';
process.env.AUDIT_MAX_PAYLOAD_CHARS = '8000';

/**
 * Cle d'API des tests d'integration.
 *
 * Les suites s'authentifient reellement plutot que de desactiver le garde :
 * une regression sur l'authentification doit faire echouer les tests, pas
 * passer inapercue.
 */
export const E2E_KEY_ID = 'e2e';
export const E2E_SECRET = ['secret', 'e2e', 'tres', 'long', 'et', 'aleatoire'].join('-');
export const E2E_AUTHORIZATION = `Bearer ${E2E_KEY_ID}.${E2E_SECRET}`;
export const E2E_READ_ONLY_AUTHORIZATION = `Bearer lecture.${[
  'secret',
  'lecture',
  'seulement',
  'tres',
  'long',
].join('-')}`;

process.env.AUTH_ENABLED = 'true';
process.env.API_KEYS =
  'e2e|1193b79696cb332993cbab421b8244fa4bbfd1cd4f9a8b28d339210e5fa46313|transfers:read,transfers:write,refunds:write,reconciliation:write,anchors:read,anchors:write,simulator:write,ledger:read,treasury:write|Tests d integration;' +
  'lecture|877fa5d4f0232aa3c748c33da682417c8428d41270a0b2df4c48e6921fc34085|transfers:read|Lecture seule';
