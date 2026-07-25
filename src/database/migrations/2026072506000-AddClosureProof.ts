import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Preuve de synthese a la cloture du dossier.
 *
 * Le chainage protege l'ordre et le contenu des faits, mais laisse une
 * ouverture : la troncature de queue. Retirer les N derniers evenements produit
 * une chaine 1..M parfaitement coherente, indiscernable d'un dossier encore en
 * cours.
 *
 * L'evenement de cloture declare le nombre total de faits et le sommet de
 * chaine. Ancre, il rend la troncature detectable — et fournit a un tiers une
 * valeur unique de 32 octets engageant tout le dossier, sans qu'il ait a
 * conserver la chaine entiere.
 *
 * Les deux colonnes sont nullables : seul l'evenement de cloture les porte, et
 * les documents anterieurs restent serialises a l'identique. Aucune empreinte
 * deja scellee n'est invalidee.
 */
export class AddClosureProof2026072506000 implements MigrationInterface {
  name = 'AddClosureProof2026072506000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "transaction_events" ` +
        `ADD "closure_event_count" integer, ` +
        `ADD "closure_chain_head" character varying(66)`,
    );
    await queryRunner.query(
      `ALTER TABLE "transaction_events"
       ADD CONSTRAINT "CHK_transaction_events_closure"
       CHECK (
         (
           "event_type" = 'CASE_CLOSED'
           AND "closure_event_count" > 1
           AND "closure_chain_head" ~ '^0x[0-9a-fA-F]{64}$'
         )
         OR
         (
           "event_type" <> 'CASE_CLOSED'
           AND "closure_event_count" IS NULL
           AND "closure_chain_head" IS NULL
         )
       )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_transaction_events_case_closed"
       ON "transaction_events" ("transaction_reference")
       WHERE "event_type" = 'CASE_CLOSED'`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "uq_transaction_events_case_closed"`);
    await queryRunner.query(
      `ALTER TABLE "transaction_events" DROP CONSTRAINT "CHK_transaction_events_closure"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transaction_events" ` +
        `DROP COLUMN "closure_chain_head", DROP COLUMN "closure_event_count"`,
    );
  }
}
