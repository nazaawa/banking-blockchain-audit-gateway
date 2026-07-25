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
