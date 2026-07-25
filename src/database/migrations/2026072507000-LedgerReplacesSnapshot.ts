import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Le registre remplace le scellement d'instantane.
 *
 * ## Pourquoi ces colonnes sont indispensables
 *
 * L'instantane prouvait le contenu de la ligne `transactions` : reconstruit puis
 * rehache, il rendait detectable la modification d'un IBAN beneficiaire. Le
 * registre, lui, ne consignait que le deroulement — statuts, montants, horodatages.
 *
 * Le remplacer sans plus aurait donc **supprime la detection d'un IBAN modifie**,
 * c'est-a-dire la demonstration centrale du projet. L'evenement d'ouverture porte
 * desormais les parties, et la verification confronte la ligne courante a cet
 * enregistrement.
 *
 * Les colonnes de scellement de `transactions` sont conservees : elles portent des
 * preuves deja publiees sur la chaine. Les detruire irait a l'encontre de tout ce
 * que ce projet cherche a etablir. Pour les nouveaux dossiers, seul
 * `anchor_status` reste une projection de compatibilite du statut de la cloture ;
 * aucune nouvelle empreinte ni preuve Merkle n'y est ecrite.
 */
export class LedgerReplacesSnapshot2026072507000 implements MigrationInterface {
  name = 'LedgerReplacesSnapshot2026072507000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "transaction_events" ` +
        `ADD "debtor_iban" character varying(34), ` +
        `ADD "debtor_name" character varying(140), ` +
        `ADD "creditor_iban" character varying(34), ` +
        `ADD "creditor_name" character varying(140), ` +
        `ADD "end_to_end_label" character varying(140)`,
    );

    // Les ouvertures 1.0 restent valides sans parties : les completer changerait
    // leur empreinte deja publiee. A partir du format 2.0, les champs structurants
    // sont obligatoires ; tous les autres faits doivent les laisser absents.
    await queryRunner.query(
      `ALTER TABLE "transaction_events"
       ADD CONSTRAINT "CHK_transaction_events_parties"
       CHECK (
         (
           "event_type" IN ('TRANSFER_INITIATED', 'PAYMENT_INITIATED')
           AND (
             (
               "record_format_version" = '1.0'
               AND "debtor_iban" IS NULL
               AND "debtor_name" IS NULL
               AND "creditor_iban" IS NULL
               AND "creditor_name" IS NULL
               AND "end_to_end_label" IS NULL
             )
             OR
             (
               "debtor_iban" IS NOT NULL
               AND "creditor_iban" IS NOT NULL
               AND "creditor_name" IS NOT NULL
             )
           )
         )
         OR
         (
           "event_type" NOT IN ('TRANSFER_INITIATED', 'PAYMENT_INITIATED')
           AND "debtor_iban" IS NULL
           AND "debtor_name" IS NULL
           AND "creditor_iban" IS NULL
           AND "creditor_name" IS NULL
           AND "end_to_end_label" IS NULL
         )
       )`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "transaction_events" DROP CONSTRAINT "CHK_transaction_events_parties"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transaction_events" ` +
        `DROP COLUMN "end_to_end_label", DROP COLUMN "creditor_name", ` +
        `DROP COLUMN "creditor_iban", DROP COLUMN "debtor_name", DROP COLUMN "debtor_iban"`,
    );
  }
}
