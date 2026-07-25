import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Socle du schema : virements classiques et piste d'audit SOAP.
 *
 * Cette migration manquait. Les suivantes supposaient un schema deja cree par
 * `synchronize: true`, ce qui rendait la chaine injouable sur une base vierge —
 * autrement dit, impossible de provisionner un environnement par migrations.
 *
 * Elle decrit l'etat du depot **avant** l'ancrage blockchain et le flux Mobile
 * Money, que les migrations suivantes ajoutent de facon incrementale. L'ordre
 * chronologique du projet est ainsi preserve plutot que reecrit.
 */
export class InitialSchema2026072400000 implements MigrationInterface {
  name = 'InitialSchema2026072400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // `uuid_generate_v4()` est la valeur par defaut des cles primaires uuid
    // generees par TypeORM. La migration reste ainsi autoportante.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // -- Virements -----------------------------------------------------------
    await queryRunner.query(
      `CREATE TYPE "public"."transactions_status_enum" AS ENUM ` +
        `('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')`,
    );
    await queryRunner.query(
      `CREATE TABLE "transactions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "reference" character varying(32) NOT NULL,
        "idempotency_key" character varying(128),
        "status" "public"."transactions_status_enum" NOT NULL DEFAULT 'PENDING',
        "debtor_iban" character varying(34) NOT NULL,
        "debtor_name" character varying(140),
        "creditor_iban" character varying(34) NOT NULL,
        "creditor_name" character varying(140) NOT NULL,
        "amount" numeric(18,2) NOT NULL,
        "currency" character(3) NOT NULL,
        "end_to_end_label" character varying(140),
        "amount_in_words" text,
        "soap_operation" character varying(64),
        "soap_duration_ms" integer,
        "soap_attempts" integer,
        "fault_code" character varying(128),
        "fault_string" character varying(1024),
        "failure_reason" character varying(512),
        "correlation_id" character varying(128) NOT NULL,
        "processed_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "version" integer NOT NULL,
        CONSTRAINT "PK_transactions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_transactions_reference" UNIQUE ("reference"),
        CONSTRAINT "UQ_transactions_idempotency_key" UNIQUE ("idempotency_key")
      )`,
    );
    await queryRunner.query(`CREATE INDEX "idx_transactions_status" ON "transactions" ("status")`);
    await queryRunner.query(
      `CREATE INDEX "idx_transactions_created_at" ON "transactions" ("created_at")`,
    );

    // -- Piste d'audit des echanges SOAP -------------------------------------
    // `DOCUMENT_VALIDATED` est ajoute par la migration d'ancrage : ce type ne
    // porte ici que les quatre directions d'origine.
    await queryRunner.query(
      `CREATE TYPE "public"."audit_logs_direction_enum" AS ENUM ` +
        `('OUTBOUND_REQUEST', 'INBOUND_RESPONSE', 'INBOUND_FAULT', 'COMMUNICATION_ERROR')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."audit_logs_outcome_enum" AS ENUM ('SUCCESS', 'FAULT', 'ERROR')`,
    );
    await queryRunner.query(
      `CREATE TABLE "audit_logs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "correlation_id" character varying(128) NOT NULL,
        "transaction_reference" character varying(32),
        "direction" "public"."audit_logs_direction_enum" NOT NULL,
        "outcome" "public"."audit_logs_outcome_enum" NOT NULL,
        "operation" character varying(64) NOT NULL,
        "endpoint" character varying(512),
        "payload" text,
        "payload_bytes" integer,
        "http_status" integer,
        "duration_ms" integer,
        "fault_code" character varying(128),
        "fault_string" character varying(1024),
        "message" character varying(1024),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_audit_logs" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_audit_logs_correlation_id" ON "audit_logs" ("correlation_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_audit_logs_transaction_reference" ` +
        `ON "audit_logs" ("transaction_reference")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_audit_logs_created_at" ON "audit_logs" ("created_at")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "audit_logs"`);
    await queryRunner.query(`DROP TYPE "public"."audit_logs_outcome_enum"`);
    await queryRunner.query(`DROP TYPE "public"."audit_logs_direction_enum"`);
    await queryRunner.query(`DROP TABLE "transactions"`);
    await queryRunner.query(`DROP TYPE "public"."transactions_status_enum"`);
  }
}
