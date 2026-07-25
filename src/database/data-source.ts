import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { DataSource } from 'typeorm';
import { AuditLog } from '../audit/entities/audit-log.entity';
import { Transaction } from '../transactions/entities/transaction.entity';

loadEnv();

/**
 * DataSource dediee a la CLI TypeORM (generation et execution des migrations).
 *
 *   npm run migration:generate -- src/database/migrations/InitialSchema
 *   npm run migration:run
 */
export default new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number.parseInt(process.env.DB_PORT ?? '5432', 10),
  username: process.env.DB_USERNAME ?? 'banking',
  password: process.env.DB_PASSWORD ?? 'banking',
  database: process.env.DB_NAME ?? 'banking_soap',
  entities: [Transaction, AuditLog],
  migrations: ['src/database/migrations/*.ts'],
  synchronize: false,
  logging: false,
});
