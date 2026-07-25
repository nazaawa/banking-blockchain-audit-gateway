import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Registre append-only des faits metier.
 *
 * L'immuabilite n'est pas une convention de code : elle est imposee par la base.
 * Un declencheur rejette toute modification d'une colonne factuelle et toute
 * suppression. Sans cela, « append-only » ne serait qu'un commentaire — et la
 * propriete centrale du modele reposerait sur la discipline de chacun.
 *
 * Les colonnes d'ancrage (`anchor_status`, `batch_id`, `leaf_index`,
 * `merkle_proof`) font exception : l'ancrage etant differe, il doit pouvoir les
 * renseigner apres coup. Elles ne portent aucun fait, seulement sa preuve.
 */
export class AddTransactionEvents2026072503000 implements MigrationInterface {
  name = 'AddTransactionEvents2026072503000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."transaction_events_event_type_enum" AS ENUM (
        'TRANSFER_INITIATED', 'TRANSFER_COMPLETED', 'TRANSFER_FAILED',
        'PAYMENT_INITIATED', 'PROVIDER_CONFIRMED', 'PROVIDER_FAILED',
        'AMOUNT_MISMATCH_DETECTED',
        'BANK_PROCESSING_BLOCKED', 'BANK_PROCESSING_COMPLETED', 'BANK_PROCESSING_FAILED',
        'RECONCILIATION_MATCHED', 'RECONCILIATION_MISMATCH',
        'CASE_OPENED', 'CASE_RESOLVED', 'CASE_CLOSED',
        'REFUND_REQUESTED', 'REFUND_COMPLETED', 'REFUND_FAILED'
      )`,
    );

    // TypeORM nomme les types enum par table et colonne : reutiliser celui des
    // transactions creerait un ecart permanent avec le schema attendu.
    for (const [suffix, values] of [
      ['anchor_status', ['NOT_SEALED', 'PENDING', 'ANCHORED', 'FAILED']],
      ['provider_status', ['INITIATED', 'PENDING', 'CONFIRMED', 'FAILED']],
      ['bank_status', ['NOT_STARTED', 'PROCESSING', 'COMPLETED', 'FAILED', 'BLOCKED']],
      [
        'reconciliation_status',
        [
          'PENDING',
          'MATCHED',
          'MISMATCH',
          'MANUAL_REVIEW',
          'AMOUNT_MISMATCH',
          'CURRENCY_MISMATCH',
          'NOT_APPLICABLE',
        ],
      ],
      ['refund_status', ['NOT_REQUIRED', 'REQUIRED', 'REQUESTED', 'COMPLETED', 'FAILED']],
      ['case_status', ['NONE', 'MANUAL_REVIEW', 'RESOLVED']],
    ] as [string, string[]][]) {
      await queryRunner.query(
        `CREATE TYPE "public"."transaction_events_${suffix}_enum" AS ENUM ` +
          `(${values.map((value) => `'${value}'`).join(', ')})`,
      );
    }

    await queryRunner.query(
      `CREATE TABLE "transaction_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "event_type" "public"."transaction_events_event_type_enum" NOT NULL,
        "sequence" integer NOT NULL,
        "transaction_reference" character varying(32) NOT NULL,
        "provider_reference" character varying(64),
        "bank_reference" character varying(64),
        "provider_status" "public"."transaction_events_provider_status_enum",
        "bank_status" "public"."transaction_events_bank_status_enum",
        "reconciliation_status" "public"."transaction_events_reconciliation_status_enum",
        "refund_status" "public"."transaction_events_refund_status_enum",
        "case_status" "public"."transaction_events_case_status_enum",
        "expected_amount" numeric(18,2) NOT NULL,
        "observed_amount" numeric(18,2),
        "currency" character(3) NOT NULL,
        "observed_currency" character(3),
        "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "correlation_id" character varying(128) NOT NULL,
        "detail" character varying(1024),
        "previous_fingerprint" character varying(66),
        "fingerprint" character varying(66) NOT NULL,
        "fingerprint_salt" character varying(66) NOT NULL,
        "record_format_version" character varying(8) NOT NULL,
        "anchor_status" "public"."transaction_events_anchor_status_enum" NOT NULL DEFAULT 'PENDING',
        "batch_id" uuid,
        "leaf_index" integer,
        "merkle_proof" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_transaction_events" PRIMARY KEY ("id"),
        CONSTRAINT "uq_transaction_events_sequence"
          UNIQUE ("transaction_reference", "sequence")
      )`,
    );

    for (const [name, column] of [
      ['idx_transaction_events_reference', 'transaction_reference'],
      ['idx_transaction_events_type', 'event_type'],
      ['idx_transaction_events_anchor_status', 'anchor_status'],
      ['idx_transaction_events_occurred_at', 'occurred_at'],
    ]) {
      await queryRunner.query(`CREATE INDEX "${name}" ON "transaction_events" ("${column}")`);
    }

    // -- Immuabilite imposee par la base --------------------------------------
    //
    // La comparaison porte sur la ligne entiere moins les colonnes d'ancrage :
    // toute colonne factuelle ajoutee plus tard est donc protegee d'office, sans
    // qu'il faille penser a modifier ce declencheur.
    await queryRunner.query(
      `CREATE OR REPLACE FUNCTION "public"."transaction_events_append_only"()
       RETURNS trigger AS $$
       BEGIN
         IF TG_OP = 'DELETE' THEN
           RAISE EXCEPTION
             'transaction_events est append-only : suppression interdite (id=%)', OLD.id
             USING ERRCODE = 'restrict_violation';
         END IF;

         IF (to_jsonb(OLD) - 'anchor_status' - 'batch_id' - 'leaf_index' - 'merkle_proof')
            IS DISTINCT FROM
            (to_jsonb(NEW) - 'anchor_status' - 'batch_id' - 'leaf_index' - 'merkle_proof') THEN
           RAISE EXCEPTION
             'transaction_events est append-only : seules les colonnes d''ancrage sont modifiables (id=%)',
             OLD.id
             USING ERRCODE = 'restrict_violation';
         END IF;

         RETURN NEW;
       END;
       $$ LANGUAGE plpgsql`,
    );

    await queryRunner.query(
      `CREATE TRIGGER "trg_transaction_events_append_only"
       BEFORE UPDATE OR DELETE ON "transaction_events"
       FOR EACH ROW EXECUTE FUNCTION "public"."transaction_events_append_only"()`,
    );

    // Note d'exploitation : TRUNCATE ne declenche pas les declencheurs de ligne.
    // En production, le role applicatif ne doit donc detenir ni TRUNCATE ni
    // DELETE sur cette table — le declencheur est une seconde barriere, pas la
    // premiere.
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_transaction_events_append_only" ON "transaction_events"`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS "public"."transaction_events_append_only"()`);
    await queryRunner.query(`DROP TABLE "transaction_events"`);
    await queryRunner.query(`DROP TYPE "public"."transaction_events_event_type_enum"`);
    for (const suffix of [
      'anchor_status',
      'provider_status',
      'bank_status',
      'reconciliation_status',
      'refund_status',
      'case_status',
    ]) {
      await queryRunner.query(`DROP TYPE "public"."transaction_events_${suffix}_enum"`);
    }
  }
}
