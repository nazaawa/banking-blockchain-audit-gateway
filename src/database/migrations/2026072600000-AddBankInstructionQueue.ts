import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * File des instructions bancaires.
 *
 * L'appel au back-office se faisait dans le traitement du webhook : l'agregateur
 * attendait notre reponse SOAP. Un back-office lent le faisait expirer, il
 * rejouait, et sa relivraison retombait sur une jambe bancaire deja reclamee —
 * la confirmation etait acquittee alors que l'appel se perdait en vol.
 *
 * La file vit dans PostgreSQL plutot que dans un courtier : la garantie
 * recherchee — l'atomicite entre la prise de la jambe bancaire et la mise en
 * file — s'obtient alors gratuitement, les deux ecritures partageant la meme
 * transaction SQL. Un courtier ajouterait une infrastructure a exploiter et un
 * second endroit ou une donnee peut se perdre.
 */
export class AddBankInstructionQueue2026072600000 implements MigrationInterface {
  name = 'AddBankInstructionQueue2026072600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."bank_instructions_status_enum" AS ENUM ` +
        `('PENDING', 'IN_FLIGHT', 'COMPLETED', 'DEAD_LETTER')`,
    );

    await queryRunner.query(
      `CREATE TABLE "bank_instructions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "transaction_reference" character varying(32) NOT NULL,
        "status" "public"."bank_instructions_status_enum" NOT NULL DEFAULT 'PENDING',
        "attempts" integer NOT NULL DEFAULT 0,
        "next_attempt_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "last_error" character varying(1024),
        "retryable" boolean NOT NULL DEFAULT true,
        "correlation_id" character varying(128) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_bank_instructions" PRIMARY KEY ("id"),
        -- Une seule instruction par transaction : la mise en file devient
        -- idempotente par construction, quelle que soit la course qui l'a
        -- provoquee.
        CONSTRAINT "UQ_bank_instructions_transaction" UNIQUE ("transaction_reference"),
        CONSTRAINT "FK_bank_instructions_transaction"
          FOREIGN KEY ("transaction_reference")
          REFERENCES "transactions"("reference") ON DELETE RESTRICT
      )`,
    );

    // Index de reclamation : le travailleur cherche les instructions echues,
    // jamais l'ensemble de la table.
    await queryRunner.query(
      `CREATE INDEX "idx_bank_instructions_claimable" ` +
        `ON "bank_instructions" ("status", "next_attempt_at")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_bank_instructions_claimable"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "bank_instructions"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."bank_instructions_status_enum"`);
  }
}
