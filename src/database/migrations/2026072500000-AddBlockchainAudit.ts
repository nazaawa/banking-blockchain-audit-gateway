import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Ajoute le scellement cryptographique et les lots d'ancrage a un schema
 * existant cree par la version REST/SOAP de la passerelle.
 */
export class AddBlockchainAudit2026072500000 implements MigrationInterface {
  name = 'AddBlockchainAudit2026072500000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."audit_logs_direction_enum" ADD VALUE IF NOT EXISTS 'DOCUMENT_VALIDATED'`,
    );

    await queryRunner.query(
      `CREATE TYPE "public"."transactions_anchor_status_enum" AS ENUM ` +
        `('NOT_SEALED', 'PENDING', 'ANCHORED', 'FAILED')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."anchor_batches_status_enum" AS ENUM ` +
        `('PENDING', 'ANCHORING', 'ANCHORED', 'FAILED')`,
    );

    await queryRunner.query(
      `CREATE TABLE "anchor_batches" (` +
        `"id" uuid NOT NULL DEFAULT uuid_generate_v4(), ` +
        `"status" "public"."anchor_batches_status_enum" NOT NULL DEFAULT 'PENDING', ` +
        `"merkle_root" character varying(66) NOT NULL, ` +
        `"leaf_count" integer NOT NULL, ` +
        `"chain_id" bigint, ` +
        `"contract_address" character varying(42), ` +
        `"tx_hash" character varying(66), ` +
        `"block_number" bigint, ` +
        `"gas_used" bigint, ` +
        `"anchored_at" TIMESTAMP WITH TIME ZONE, ` +
        `"attempts" integer NOT NULL DEFAULT 0, ` +
        `"last_error" character varying(1024), ` +
        `"created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), ` +
        `"updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), ` +
        `CONSTRAINT "PK_anchor_batches_id" PRIMARY KEY ("id")` +
        `)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_anchor_batches_status" ON "anchor_batches" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_anchor_batches_created_at" ON "anchor_batches" ("created_at")`,
    );

    await queryRunner.query(
      `ALTER TABLE "transactions" ` +
        `ADD "fingerprint" character varying(66), ` +
        `ADD "fingerprint_salt" character varying(66), ` +
        `ADD "record_format_version" character varying(8), ` +
        `ADD "sealed_at" TIMESTAMP WITH TIME ZONE, ` +
        `ADD "anchor_status" "public"."transactions_anchor_status_enum" ` +
        `NOT NULL DEFAULT 'NOT_SEALED', ` +
        `ADD "batch_id" uuid, ` +
        `ADD "leaf_index" integer, ` +
        `ADD "merkle_proof" jsonb`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_transactions_anchor_status" ON "transactions" ("anchor_status")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_transactions_anchor_status"`);
    await queryRunner.query(
      `ALTER TABLE "transactions" ` +
        `DROP COLUMN "merkle_proof", ` +
        `DROP COLUMN "leaf_index", ` +
        `DROP COLUMN "batch_id", ` +
        `DROP COLUMN "anchor_status", ` +
        `DROP COLUMN "sealed_at", ` +
        `DROP COLUMN "record_format_version", ` +
        `DROP COLUMN "fingerprint_salt", ` +
        `DROP COLUMN "fingerprint"`,
    );

    await queryRunner.query(`DROP INDEX "public"."idx_anchor_batches_created_at"`);
    await queryRunner.query(`DROP INDEX "public"."idx_anchor_batches_status"`);
    await queryRunner.query(`DROP TABLE "anchor_batches"`);
    await queryRunner.query(`DROP TYPE "public"."anchor_batches_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."transactions_anchor_status_enum"`);

    // PostgreSQL ne sait pas retirer une valeur d'enum directement. La
    // recreation conserve les quatre directions de la version precedente.
    await queryRunner.query(`DELETE FROM "audit_logs" WHERE "direction" = 'DOCUMENT_VALIDATED'`);
    await queryRunner.query(
      `ALTER TYPE "public"."audit_logs_direction_enum" RENAME TO "audit_logs_direction_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."audit_logs_direction_enum" AS ENUM ` +
        `('OUTBOUND_REQUEST', 'INBOUND_RESPONSE', 'INBOUND_FAULT', 'COMMUNICATION_ERROR')`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_logs" ALTER COLUMN "direction" TYPE ` +
        `"public"."audit_logs_direction_enum" USING ` +
        `"direction"::text::"public"."audit_logs_direction_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."audit_logs_direction_enum_old"`);
  }
}
