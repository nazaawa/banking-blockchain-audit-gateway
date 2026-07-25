-- Execute une seule fois, a la creation du volume PostgreSQL.
--
-- `uuid-ossp` fournit uuid_generate_v4(), utilise par TypeORM comme valeur par
-- defaut des colonnes @PrimaryGeneratedColumn('uuid').
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Base dediee aux tests d'integration (npm run test:e2e).
SELECT 'CREATE DATABASE banking_soap_test'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'banking_soap_test')\gexec
