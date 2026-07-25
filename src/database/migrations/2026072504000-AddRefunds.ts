import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Dossiers de remboursement.
 *
 * Table dediee plutot que colonnes ajoutees a `transactions` : celle-ci porte
 * deja deux cycles de vie, et un troisieme aggraverait une dette de structure
 * connue. La contrainte d'unicite sur la reference garantit qu'une transaction
 * n'ouvre jamais deux dossiers concurrents.
 */
export class AddRefunds2026072504000 implements MigrationInterface {
  name = 'AddRefunds2026072504000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."refunds_status_enum" AS ENUM ` +
        `('NOT_REQUIRED', 'REQUIRED', 'REQUESTED', 'COMPLETED', 'FAILED')`,
    );

    await queryRunner.query(
      `CREATE TABLE "refunds" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "transaction_reference" character varying(32) NOT NULL,
        "status" "public"."refunds_status_enum" NOT NULL DEFAULT 'REQUIRED',
        "amount" numeric(18,2) NOT NULL,
        "currency" character(3) NOT NULL,
        "reason" character varying(512),
        "provider_idempotency_key" character varying(64) NOT NULL,
        "provider_refund_reference" character varying(64),
        "attempts" integer NOT NULL DEFAULT 0,
        "last_error" character varying(1024),
        "retryable" boolean NOT NULL DEFAULT true,
        "requested_at" TIMESTAMP WITH TIME ZONE,
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "requested_by" character varying(128),
        "correlation_id" character varying(128) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_refunds" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_refunds_provider_idempotency_key" UNIQUE ("provider_idempotency_key"),
        -- Nom genere par TypeORM pour cette relation. Le conserver evite que
        -- \`synchronize\` ne supprime puis recree la contrainte a chaque demarrage.
        CONSTRAINT "FK_3f15b380c76f06414528b35604f" FOREIGN KEY ("transaction_reference")
          REFERENCES "transactions"("reference") ON DELETE RESTRICT
      )`,
    );

    await queryRunner.query(`CREATE INDEX "idx_refunds_status" ON "refunds" ("status")`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_refunds_transaction_reference" ` +
        `ON "refunds" ("transaction_reference")`,
    );

    // Reprise : ouvrir les dossiers des transactions deja marquees comme devant
    // etre remboursees, afin qu'aucune dette anterieure a cette migration ne
    // reste invisible du flux.
    await queryRunner.query(
      `INSERT INTO "refunds" (
         "transaction_reference", "status", "amount", "currency", "reason",
         "provider_idempotency_key", "correlation_id"
       )
       SELECT
         t."reference",
         'REQUIRED',
         t."aggregator_amount",
         t."aggregator_currency",
         COALESCE(t."case_reason", t."failure_reason"),
         'RFD-MIGR-' || replace(t."id"::text, '-', ''),
         t."correlation_id"
       FROM "transactions" t
       WHERE t."refund_status" = 'REQUIRED'
         AND t."aggregator_amount" IS NOT NULL
         AND t."aggregator_currency" IS NOT NULL
       ON CONFLICT ("transaction_reference") DO NOTHING`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "refunds"`);
    await queryRunner.query(`DROP TYPE "public"."refunds_status_enum"`);
  }
}
