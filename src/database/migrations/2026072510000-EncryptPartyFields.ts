import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Chiffrement au repos des donnees de partie.
 *
 * ## Ce que la migration fait, et ne fait pas
 *
 * Elle elargit les colonnes pour accueillir le chiffre. La migration suivante
 * convertit les lignes historiques et interdit ensuite tout retour au clair.
 *
 * ## Pourquoi les empreintes ne bougent pas
 *
 * Le chiffrement vit dans un transformateur TypeORM, donc **sous** l'entite. Le
 * document XML canonique est construit depuis les valeurs en clair : les
 * empreintes deja scellees et publiees restent verifiables a l'octet pres.
 */
export class EncryptPartyFields2026072510000 implements MigrationInterface {
  name = 'EncryptPartyFields2026072510000';

  private readonly columns: ReadonlyArray<[table: string, column: string]> = [
    ['transactions', 'debtor_iban'],
    ['transactions', 'debtor_name'],
    ['transactions', 'creditor_iban'],
    ['transactions', 'creditor_name'],
    ['transaction_events', 'debtor_iban'],
    ['transaction_events', 'debtor_name'],
    ['transaction_events', 'creditor_iban'],
    ['transaction_events', 'creditor_name'],
  ];

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const [table, column] of this.columns) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE character varying(512)`,
      );
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Le retour arriere n'est sur que si aucune valeur chiffree ne subsiste :
    // un chiffre tronque a 34 caracteres serait irrecuperable. La migration
    // refuse donc plutot que de detruire.
    for (const [table, column] of this.columns) {
      const rows = (await queryRunner.query(
        `SELECT COUNT(*)::text AS count FROM "${table}" WHERE "${column}" LIKE 'enc.v1.%'`,
      )) as Array<{ count: string }>;
      const count = rows[0]?.count ?? '0';

      if (Number.parseInt(count, 10) > 0) {
        throw new Error(
          `Retour arriere refuse : ${count} valeur(s) chiffree(s) dans ${table}.${column}. ` +
            'Les dechiffrer avant de retrecir la colonne, sinon elles seront tronquees.',
        );
      }
    }

    for (const [table, column] of this.columns) {
      const width = column.endsWith('_iban') ? 34 : 140;
      await queryRunner.query(
        `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE character varying(${width})`,
      );
    }
  }
}
