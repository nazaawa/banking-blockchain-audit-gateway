import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Ajoute le cycle Mobile Money, les webhooks idempotents et le rapprochement. */
export class AddMobileMoneyFlow2026072501000 implements MigrationInterface {
  name = 'AddMobileMoneyFlow2026072501000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."transactions_payment_channel_enum" AS ENUM ` +
        `('LEGACY_TRANSFER', 'MOBILE_MONEY')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."transactions_mobile_money_operator_enum" AS ENUM ` +
        `('MPESA', 'AIRTEL_MONEY', 'ORANGE_MONEY')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."transactions_mobile_money_status_enum" AS ENUM ` +
        `('INITIATED', 'PENDING', 'CONFIRMED', 'FAILED')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."transactions_bank_status_enum" AS ENUM ` +
        `('NOT_STARTED', 'PROCESSING', 'COMPLETED', 'FAILED')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."transactions_reconciliation_status_enum" AS ENUM ` +
        `('PENDING', 'MATCHED', 'MISMATCH', 'MANUAL_REVIEW')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."mobile_money_webhook_events_processing_status_enum" AS ENUM ` +
        `('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED')`,
    );

    await queryRunner.query(
      `ALTER TABLE "transactions" ` +
        `ADD "payment_channel" "public"."transactions_payment_channel_enum" ` +
        `NOT NULL DEFAULT 'LEGACY_TRANSFER', ` +
        `ADD "mobile_money_operator" "public"."transactions_mobile_money_operator_enum", ` +
        `ADD "payer_msisdn" character varying(16), ` +
        `ADD "aggregator_reference" character varying(64), ` +
        `ADD "mobile_money_status" "public"."transactions_mobile_money_status_enum", ` +
        `ADD "bank_status" "public"."transactions_bank_status_enum", ` +
        `ADD "reconciliation_status" "public"."transactions_reconciliation_status_enum", ` +
        `ADD "aggregator_amount" numeric(18,2), ` +
        `ADD "aggregator_currency" character(3), ` +
        `ADD "mobile_money_confirmed_at" TIMESTAMP WITH TIME ZONE, ` +
        `ADD "reconciled_at" TIMESTAMP WITH TIME ZONE, ` +
        `ADD "reconciliation_reason" character varying(512), ` +
        `ADD CONSTRAINT "UQ_transactions_aggregator_reference" UNIQUE ("aggregator_reference")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_transactions_reconciliation" ON "transactions" ` +
        `("payment_channel", "reconciliation_status")`,
    );

    await queryRunner.query(
      `CREATE TABLE "mobile_money_webhook_events" (` +
        `"id" uuid NOT NULL DEFAULT uuid_generate_v4(), ` +
        `"event_id" character varying(128) NOT NULL, ` +
        `"aggregator_reference" character varying(64) NOT NULL, ` +
        `"processing_status" ` +
        `"public"."mobile_money_webhook_events_processing_status_enum" ` +
        `NOT NULL DEFAULT 'RECEIVED', ` +
        `"payload" jsonb NOT NULL, ` +
        `"failure_reason" character varying(1024), ` +
        `"processed_at" TIMESTAMP WITH TIME ZONE, ` +
        `"created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), ` +
        `"updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), ` +
        `CONSTRAINT "UQ_mm_webhook_event_id" UNIQUE ("event_id"), ` +
        `CONSTRAINT "PK_mobile_money_webhook_events_id" PRIMARY KEY ("id")` +
        `)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_mm_webhook_aggregator_reference" ` +
        `ON "mobile_money_webhook_events" ("aggregator_reference")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_mm_webhook_processing_status" ` +
        `ON "mobile_money_webhook_events" ("processing_status")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_mm_webhook_processing_status"`);
    await queryRunner.query(`DROP INDEX "public"."idx_mm_webhook_aggregator_reference"`);
    await queryRunner.query(`DROP TABLE "mobile_money_webhook_events"`);
    await queryRunner.query(`DROP INDEX "public"."idx_transactions_reconciliation"`);
    await queryRunner.query(
      `ALTER TABLE "transactions" ` +
        `DROP CONSTRAINT "UQ_transactions_aggregator_reference", ` +
        `DROP COLUMN "reconciliation_reason", ` +
        `DROP COLUMN "reconciled_at", ` +
        `DROP COLUMN "mobile_money_confirmed_at", ` +
        `DROP COLUMN "aggregator_currency", ` +
        `DROP COLUMN "aggregator_amount", ` +
        `DROP COLUMN "reconciliation_status", ` +
        `DROP COLUMN "bank_status", ` +
        `DROP COLUMN "mobile_money_status", ` +
        `DROP COLUMN "aggregator_reference", ` +
        `DROP COLUMN "payer_msisdn", ` +
        `DROP COLUMN "mobile_money_operator", ` +
        `DROP COLUMN "payment_channel"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."mobile_money_webhook_events_processing_status_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."transactions_reconciliation_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."transactions_bank_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."transactions_mobile_money_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."transactions_mobile_money_operator_enum"`);
    await queryRunner.query(`DROP TYPE "public"."transactions_payment_channel_enum"`);
  }
}
