import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Identites structurees et scellees des actions de remboursement.
 *
 * `refunds` conserve la vue courante necessaire au controle de separation des
 * taches. `transaction_events` conserve la preuve immuable : acteur, role et
 * origine entrent dans le XML canonique, donc dans l'empreinte.
 */
export class AddEventActorsAndRefundActors2026072512000 implements MigrationInterface {
  name = 'AddEventActorsAndRefundActors2026072512000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "refunds" RENAME COLUMN "requested_by" TO "created_by"`);
    await queryRunner.query(
      `ALTER TABLE "refunds" ADD COLUMN "last_requested_by" character varying(128)`,
    );
    await queryRunner.query(
      `ALTER TABLE "refunds" ADD COLUMN "last_approved_by" character varying(128)`,
    );
    await queryRunner.query(
      `UPDATE "refunds" SET "last_requested_by" = "created_by" WHERE "created_by" IS NOT NULL`,
    );

    await queryRunner.query(
      `ALTER TABLE "transaction_events"
       ADD COLUMN "actor_id" character varying(128),
       ADD COLUMN "actor_role" character varying(32),
       ADD COLUMN "action_origin" character varying(32)`,
    );
    await queryRunner.query(
      `ALTER TABLE "transaction_events"
       ADD CONSTRAINT "CHK_transaction_events_actor_context"
       CHECK (
         ("actor_id" IS NULL AND "actor_role" IS NULL AND "action_origin" IS NULL)
         OR
         ("actor_id" IS NOT NULL AND "actor_role" IS NOT NULL AND "action_origin" IS NOT NULL)
       )`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const actorRows = (await queryRunner.query(
      `SELECT COUNT(*)::int AS count
         FROM "transaction_events"
        WHERE "actor_id" IS NOT NULL`,
    )) as Array<{ count: number }>;
    const evolvedRefunds = (await queryRunner.query(
      `SELECT COUNT(*)::int AS count
         FROM "refunds"
        WHERE "last_approved_by" IS NOT NULL
           OR "last_requested_by" IS DISTINCT FROM "created_by"`,
    )) as Array<{ count: number }>;

    if ((actorRows[0]?.count ?? 0) > 0 || (evolvedRefunds[0]?.count ?? 0) > 0) {
      throw new Error(
        'Retour arriere refuse : des identites scellees ou une separation des taches ' +
          'posterieure a la creation seraient perdues.',
      );
    }

    await queryRunner.query(
      `ALTER TABLE "transaction_events" DROP CONSTRAINT "CHK_transaction_events_actor_context"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transaction_events"
       DROP COLUMN "action_origin",
       DROP COLUMN "actor_role",
       DROP COLUMN "actor_id"`,
    );
    await queryRunner.query(`ALTER TABLE "refunds" DROP COLUMN "last_approved_by"`);
    await queryRunner.query(`ALTER TABLE "refunds" DROP COLUMN "last_requested_by"`);
    await queryRunner.query(`ALTER TABLE "refunds" RENAME COLUMN "created_by" TO "requested_by"`);
  }
}
