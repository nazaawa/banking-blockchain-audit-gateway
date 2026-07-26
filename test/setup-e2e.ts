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
// Obligatoire pour la validation de configuration. Les suites remplacent le
// client SOAP avant de demarrer l'application : cette URL n'est jamais appelee.
process.env.SOAP_ENDPOINT = 'https://example.test/soap';
process.env.SOAP_WSDL_SOURCE = 'local';
process.env.ALLOWED_CURRENCIES = 'EUR,USD,GBP';
process.env.TRANSFER_MAX_AMOUNT = '1000000';
process.env.AUDIT_PERSIST_PAYLOADS = 'true';
process.env.AUDIT_MAX_PAYLOAD_CHARS = '8000';
process.env.SECURITY_CURRENT_KEY_ID = 'e2e-v1';
process.env.SECURITY_MASTER_KEY = Buffer.from(
  Array.from({ length: 32 }, (_, index) => index + 1),
).toString('base64');
process.env.SECURITY_KEY_SALT = 'e2e-hkdf-salt-stable';

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
/**
 * Second acteur, habilite au seul controle.
 *
 * La separation des taches ne se demontre qu'avec deux cles distinctes : une
 * suite qui rouvrirait un dossier avec la cle qui l'a demande ne prouverait
 * rien, sinon que le controle est absent.
 */
export const E2E_APPROVER_AUTHORIZATION = `Bearer controle.${[
  'secret',
  'controle',
  'tres',
  'long',
  'et',
  'aleatoire',
].join('-')}`;

/**
 * Acteur cumulant les deux habilitations.
 *
 * Il sert a prouver que la separation des taches ne repose **pas** sur les
 * seules habilitations : meme muni des deux, un acteur ne peut pas approuver ce
 * qu'il a lui-meme demande.
 */
export const E2E_SELF_APPROVER_AUTHORIZATION = `Bearer cumul.${[
  'secret',
  'cumul',
  'tres',
  'long',
  'et',
  'aleatoire',
].join('-')}`;

export const E2E_READ_ONLY_AUTHORIZATION = `Bearer lecture.${[
  'secret',
  'lecture',
  'seulement',
  'tres',
  'long',
].join('-')}`;

// Le travailleur d'instructions bancaires est pilote explicitement par les
// suites : un ordonnanceur en tache de fond rendrait leurs assertions
// dependantes du moment ou il passe.
process.env.MOBILE_MONEY_BANK_WORKER_ENABLED = 'false';

process.env.AUTH_ENABLED = 'true';
process.env.API_KEYS =
  'e2e|1193b79696cb332993cbab421b8244fa4bbfd1cd4f9a8b28d339210e5fa46313|transfers:read,transfers:write,refunds:write,reconciliation:write,anchors:read,anchors:write,simulator:write,ledger:read,treasury:write|Tests d integration;' +
  'cumul|53f052596e4e07536e16f3517577f5af29c2d14a2b012d412703371f518b1c04|transfers:read,transfers:write,refunds:write,refunds:approve,simulator:write,reconciliation:write|Cumul des roles;' +
  'controle|0b14fdc27edcd08931aeaf0d641283f53e5a187363883034529ab74b3bf6f8e7|transfers:read,refunds:approve|Controle et approbation;' +
  'lecture|877fa5d4f0232aa3c748c33da682417c8428d41270a0b2df4c48e6921fc34085|transfers:read|Lecture seule';
