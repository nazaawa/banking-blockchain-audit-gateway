import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Chiffrement au repos des donnees de partie.
 *
 * ## Ce que la migration fait, et ne fait pas
 *
 * Elle **elargit** les colonnes : un IBAN tient dans 34 caracteres, son chiffre
 * en base64url dans environ 90. Elle ne convertit **aucune** donnee existante.
 *
 * Les lignes anterieures restent en clair et sont lues telles quelles — le
 * chiffre porte un prefixe de version qui les distingue. Toute ecriture chiffre,
 * y compris la reecriture d'une ligne heritee.
 *
 * Convertir en masse supposerait de disposer de la cle au moment de la
 * migration, donc de la faire transiter par l'outillage de schema. Le gain — des
 * lignes de demonstration chiffrees — ne justifie pas d'elargir la surface
 * d'exposition du secret.
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
