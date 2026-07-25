import { MigrationInterface, QueryRunner } from 'typeorm';
import { LEDGER_GUARD_STATEMENTS, LEDGER_TRIGGERS } from '../../accounting/ledger-guards';

/**
 * Ledger comptable en partie double.
 *
 * Deux garanties sont posees en base plutot que dans l'application :
 *
 * 1. **Equilibre** — la somme des debits d'une ecriture egale celle de ses
 *    credits. Verifie par declencheur `CONSTRAINT ... DEFERRABLE`, donc au
 *    commit : les lignes sont inserees une a une, l'ecriture n'est complete
 *    qu'a la fin de la transaction.
 * 2. **Immuabilite** — ecritures et lignes sont append-only. Une erreur
 *    comptable se corrige par contre-passation, jamais par reecriture : c'est
 *    la regle qui rend un journal opposable.
 *
 * Les placer ici plutot que dans le service est deliberé. Un journal dont
 * l'equilibre ne tiendrait qu'a la justesse du code appelant ne prouverait
 * rien — et c'est precisement ce que ce projet cherche a etablir.
 */
export class AddDoubleEntryLedger2026072509000 implements MigrationInterface {
  name = 'AddDoubleEntryLedger2026072509000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // --- Commission figee sur la transaction -------------------------------
    await queryRunner.query(
      `ALTER TABLE "transactions" ADD COLUMN "fee_amount" numeric(18,2) NOT NULL DEFAULT 0`,
    );

    // --- Nouveau fait : rapatriement des fonds -----------------------------
    // Ajout additif a l'enumeration : aucun document existant n'est affecte,
    // donc aucune empreinte deja scellee ne bouge.
    await queryRunner.query(
      `ALTER TYPE "public"."transaction_events_event_type_enum" ADD VALUE IF NOT EXISTS 'SETTLEMENT_SWEPT'`,
    );

    // --- Plan de comptes ---------------------------------------------------
    await queryRunner.query(
      `CREATE TYPE "public"."journal_lines_account_enum" AS ENUM ` +
        `('PROVIDER_FLOAT', 'SETTLEMENT', 'CREDITOR_PAYABLE', 'PAYER_PAYABLE', 'FEE_REVENUE')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."journal_lines_direction_enum" AS ENUM ('DEBIT', 'CREDIT')`,
    );

    await queryRunner.query(
      `CREATE TABLE "journal_entries" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "transaction_reference" character varying(32) NOT NULL,
        "event_id" uuid NOT NULL,
        "event_type" character varying(48) NOT NULL,
        "narration" character varying(256) NOT NULL,
        "currency" char(3) NOT NULL,
        "correlation_id" character varying(128) NOT NULL,
        "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_journal_entries" PRIMARY KEY ("id"),
        -- Un fait ne produit qu'une ecriture : la comptabilisation est donc
        -- idempotente par construction, et non par convention d'appel.
        CONSTRAINT "uq_journal_entries_event" UNIQUE ("event_id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_journal_entries_reference" ON "journal_entries" ("transaction_reference")`,
    );

    await queryRunner.query(
      `CREATE TABLE "journal_lines" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "entry_id" uuid NOT NULL,
        "account" "public"."journal_lines_account_enum" NOT NULL,
        "direction" "public"."journal_lines_direction_enum" NOT NULL,
        "amount" numeric(18,2) NOT NULL,
        CONSTRAINT "PK_journal_lines" PRIMARY KEY ("id"),
        -- Le couple (compte, sens) porte deja le signe : un montant negatif
        -- serait ambigu entre « credit » et « annulation ».
        CONSTRAINT "CHK_journal_lines_amount_positive" CHECK ("amount" > 0)
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_journal_lines_account" ON "journal_lines" ("account")`,
    );

    // --- Cles etrangeres ---------------------------------------------------
    // Une ecriture qui referencerait un fait inexistant viderait de son sens la
    // regle « le journal ne dit rien que le registre n atteste deja ».
    await queryRunner.query(
      `ALTER TABLE "journal_entries" ADD CONSTRAINT "FK_journal_entries_event" ` +
        `FOREIGN KEY ("event_id") REFERENCES "transaction_events"("id") ON DELETE RESTRICT`,
    );
    await queryRunner.query(
      `ALTER TABLE "journal_lines" ADD CONSTRAINT "FK_journal_lines_entry" ` +
        `FOREIGN KEY ("entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT`,
    );

    // --- Garanties : equilibre et immuabilite ------------------------------
    // Le texte SQL est partage avec l'installateur de demarrage, afin que les
    // deux chemins de provisionnement ne puissent pas diverger.
    for (const statement of LEDGER_GUARD_STATEMENTS) {
      await queryRunner.query(statement);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const [trigger, table] of LEDGER_TRIGGERS) {
      await queryRunner.query(`DROP TRIGGER IF EXISTS "${trigger}" ON "${table}"`);
    }
    await queryRunner.query(`DROP FUNCTION IF EXISTS "public"."journal_entries_balanced"()`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS "public"."journal_lines_balanced"()`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS "public"."journal_append_only"()`);

    await queryRunner.query(`DROP INDEX IF EXISTS "idx_journal_lines_account"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "journal_lines"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_journal_entries_reference"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "journal_entries"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."journal_lines_direction_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."journal_lines_account_enum"`);
    await queryRunner.query(`ALTER TABLE "transactions" DROP COLUMN "fee_amount"`);
    // La valeur d'enumeration n'est pas retiree : PostgreSQL ne sait pas le
    // faire, et des faits deja consignes peuvent la porter.
  }
}
