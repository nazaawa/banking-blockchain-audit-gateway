import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Separe les dimensions d'etat du paiement Mobile Money.
 *
 * Auparavant, `TransactionStatus` et `reconciliation_status` portaient a eux
 * seuls des faits orthogonaux : ce que le fournisseur a encaisse, ce que la
 * banque a execute, ce que le rapprochement constate, ce qui est du au payeur,
 * et ce qu'un operateur doit instruire. Les confondre rendait inexprimable
 * l'etat le plus important du flux — « encaisse mais non vire, remboursement
 * du » — et conduisait a marquer FAILED un paiement fournisseur reussi.
 *
 * Trois changements :
 *  1. `mobile_money_status` devient `provider_status` (renommage sans perte) ;
 *  2. `bank_status` gagne BLOCKED, `reconciliation_status` gagne AMOUNT_MISMATCH,
 *     CURRENCY_MISMATCH et NOT_APPLICABLE ;
 *  3. `refund_status`, `case_status` et `case_reason` apparaissent.
 */
export class SplitPaymentStatuses2026072502000 implements MigrationInterface {
  name = 'SplitPaymentStatuses2026072502000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // --- 1. Renommage : la colonne et son type, sans toucher aux donnees ------
    await queryRunner.query(
      `ALTER TABLE "transactions" RENAME COLUMN "mobile_money_status" TO "provider_status"`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."transactions_mobile_money_status_enum" ` +
        `RENAME TO "transactions_provider_status_enum"`,
    );

    // --- 2. Nouvelles valeurs d'enum -----------------------------------------
    // `ADD VALUE` est cumulatif et ne reecrit pas la table : les lignes
    // existantes conservent leur valeur.
    await queryRunner.query(
      `ALTER TYPE "public"."transactions_bank_status_enum" ADD VALUE IF NOT EXISTS 'BLOCKED'`,
    );
    for (const value of ['AMOUNT_MISMATCH', 'CURRENCY_MISMATCH', 'NOT_APPLICABLE']) {
      await queryRunner.query(
        `ALTER TYPE "public"."transactions_reconciliation_status_enum" ` +
          `ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }

    // --- 3. Dimensions remboursement et dossier ------------------------------
    await queryRunner.query(
      `CREATE TYPE "public"."transactions_refund_status_enum" AS ENUM ` +
        `('NOT_REQUIRED', 'REQUIRED', 'REQUESTED', 'COMPLETED', 'FAILED')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."transactions_case_status_enum" AS ENUM ` +
        `('NONE', 'MANUAL_REVIEW', 'RESOLVED')`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" ` +
        `ADD "refund_status" "public"."transactions_refund_status_enum" ` +
        `NOT NULL DEFAULT 'NOT_REQUIRED', ` +
        `ADD "case_status" "public"."transactions_case_status_enum" ` +
        `NOT NULL DEFAULT 'NONE', ` +
        `ADD "case_reason" character varying(512)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_transactions_case_status" ON "transactions" ("case_status")`,
    );

    // --- 4. Reprise des lignes deja en anomalie -------------------------------
    // Une transaction Mobile Money dont le fournisseur a encaisse sans que la
    // banque ait abouti porte une dette : la marquer retroactivement evite que
    // les dossiers anterieurs a cette migration restent invisibles.
    await queryRunner.query(
      `UPDATE "transactions" SET ` +
        `"refund_status" = 'REQUIRED', ` +
        `"case_status" = 'MANUAL_REVIEW', ` +
        `"case_reason" = 'Reprise de migration : encaissement fournisseur sans virement abouti' ` +
        `WHERE "payment_channel" = 'MOBILE_MONEY' ` +
        `AND "provider_status" = 'CONFIRMED' ` +
        `AND "bank_status" <> 'COMPLETED'`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_transactions_case_status"`);
    await queryRunner.query(
      `ALTER TABLE "transactions" ` +
        `DROP COLUMN "case_reason", DROP COLUMN "case_status", DROP COLUMN "refund_status"`,
    );
    await queryRunner.query(`DROP TYPE "public"."transactions_case_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."transactions_refund_status_enum"`);

    await queryRunner.query(
      `ALTER TYPE "public"."transactions_provider_status_enum" ` +
        `RENAME TO "transactions_mobile_money_status_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" RENAME COLUMN "provider_status" TO "mobile_money_status"`,
    );

    // PostgreSQL ne sait pas retirer une valeur d'un type enum : les valeurs
    // BLOCKED, AMOUNT_MISMATCH, CURRENCY_MISMATCH et NOT_APPLICABLE subsistent.
    // Elles sont inertes tant qu'aucune ligne ne les porte.
  }
}
