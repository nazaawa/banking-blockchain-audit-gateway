import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Invariants entre dimensions de statut, imposes par la base.
 *
 * `TransactionStateMachine` les verifie deja au plus pres de leur cause, avec un
 * diagnostic nomme. Ces contraintes ferment ce qui la contourne : script
 * d'exploitation, correctif manuel applique en urgence, ou service futur qui
 * ecrirait sans passer par elle.
 *
 * Le registre etant append-only, un etat impossible n'est pas rattrapable : il
 * est consigne, scelle, puis publie. La redondance se justifie par la seule
 * chose qui compte ici — ce qui est ecrit ne se reprend pas.
 *
 * La table de transitions, elle, n'est pas reproduite : une contrainte `CHECK`
 * ne voit que la ligne resultante, jamais l'etat dont elle provient.
 */
export class AddStateInvariants2026072508000 implements MigrationInterface {
  name = 'AddStateInvariants2026072508000';

  private readonly constraints: ReadonlyArray<[string, string]> = [
    [
      // La banque ne peut etre instruite que sur un encaissement confirme :
      // c'est le garde-fou contre un mouvement de fonds sans contrepartie.
      'CHK_transactions_bank_requires_provider',
      `"payment_channel"::text <> 'MOBILE_MONEY' OR "bank_status" IS NULL ` +
        `OR "bank_status"::text = 'NOT_STARTED' OR "provider_status"::text = 'CONFIRMED'`,
    ],
    [
      // On ne rembourse que ce qui a ete encaisse.
      'CHK_transactions_refund_requires_collection',
      `"payment_channel"::text <> 'MOBILE_MONEY' OR "refund_status" IS NULL ` +
        `OR "refund_status"::text = 'NOT_REQUIRED' OR "provider_status"::text = 'CONFIRMED'`,
    ],
    [
      // La resolution ouvre la cloture, donc l'ancrage : la sceller dette
      // pendante publierait une extinction qui n'a pas eu lieu.
      'CHK_transactions_resolved_case_needs_extinct_debt',
      `"case_status"::text <> 'RESOLVED' OR "refund_status" IS NULL ` +
        `OR "refund_status"::text IN ('COMPLETED', 'NOT_REQUIRED')`,
    ],
    [
      // Un rapprochement conforme suppose que les deux jambes ont abouti.
      'CHK_transactions_matched_needs_both_legs',
      `"reconciliation_status"::text <> 'MATCHED' OR "payment_channel"::text <> 'MOBILE_MONEY' ` +
        `OR ("provider_status"::text = 'CONFIRMED' AND "bank_status"::text = 'COMPLETED')`,
    ],
    [
      // Un blocage bancaire est toujours motive par un ecart constate et nomme.
      'CHK_transactions_blocked_bank_needs_gap',
      `"bank_status"::text <> 'BLOCKED' ` +
        `OR "reconciliation_status"::text IN ('AMOUNT_MISMATCH', 'CURRENCY_MISMATCH')`,
    ],
  ];

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const [name, predicate] of this.constraints) {
      await queryRunner.query(
        `ALTER TABLE "transactions" ADD CONSTRAINT "${name}" CHECK (${predicate})`,
      );
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const [name] of [...this.constraints].reverse()) {
      await queryRunner.query(`ALTER TABLE "transactions" DROP CONSTRAINT "${name}"`);
    }
  }
}
