import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Deux correctifs issus de la revue des ajouts precedents.
 *
 * 1. `REFUND_REOPENED` — un refus metier rendait le remboursement definitivement
 *    non rejouable. Or la cause se resout souvent hors systeme (le marchand
 *    recharge son solde) : sans chemin de reouverture, une situation
 *    recuperable devenait une impasse ne se debloquant que par une ecriture
 *    directe en base.
 *
 * 2. Cles etrangeres sur le registre d'evenements. `refunds` en portait une,
 *    pas le registre — pourtant c'est lui qui en a le plus besoin : un
 *    evenement orphelin est une preuve qui ne reference rien.
 *
 * `audit_logs` reste volontairement sans contrainte : la piste est best-effort
 * et ne doit jamais faire echouer l'operation metier. Une violation y perdrait
 * silencieusement des enregistrements, le service absorbant ses erreurs.
 */
export class RefundReopenAndIntegrity2026072505000 implements MigrationInterface {
  name = 'RefundReopenAndIntegrity2026072505000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."transaction_events_event_type_enum" ` +
        `ADD VALUE IF NOT EXISTS 'REFUND_REOPENED'`,
    );

    // RESTRICT et non CASCADE : propager la suppression d'une preuve ou d'une
    // ecriture financiere serait exactement ce que ce projet cherche a rendre
    // impossible.
    await queryRunner.query(
      `ALTER TABLE "transaction_events"
       ADD CONSTRAINT "FK_9b4f1429d09c11998c71b1f4f15"
       FOREIGN KEY ("transaction_reference") REFERENCES "transactions"("reference")
       ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "transaction_events"
       ADD CONSTRAINT "FK_a4627b37c095b121ea3d037a9cc"
       FOREIGN KEY ("batch_id") REFERENCES "anchor_batches"("id")
       ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions"
       ADD CONSTRAINT "FK_c48c2d1b2a2355694c35c082981"
       FOREIGN KEY ("batch_id") REFERENCES "anchor_batches"("id")
       ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "transactions" DROP CONSTRAINT "FK_c48c2d1b2a2355694c35c082981"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transaction_events" DROP CONSTRAINT "FK_a4627b37c095b121ea3d037a9cc"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transaction_events" DROP CONSTRAINT "FK_9b4f1429d09c11998c71b1f4f15"`,
    );
    // PostgreSQL ne sait pas retirer une valeur d'un type enum : REFUND_REOPENED
    // subsiste, inerte tant qu'aucune ligne ne la porte.
  }
}
