import { MigrationInterface, QueryRunner } from 'typeorm';
import { FieldCipher } from '../../security/field-cipher';
import {
  DEFAULT_SECURITY_KEY_SALT,
  decodeMasterKey,
  deriveDataEncryptionKey,
  deriveLegacyDataEncryptionKey,
  LEGACY_LOCAL_SECURITY_MASTER_KEY,
  LOCAL_SECURITY_KEY_ID,
  LOCAL_SECURITY_MASTER_KEY,
  parsePreviousKeys,
} from '../../security/key-derivation';

type PartyColumn = {
  table: 'transactions' | 'transaction_events';
  column: 'debtor_iban' | 'debtor_name' | 'creditor_iban' | 'creditor_name';
};

type PartyRow = {
  id: string;
  debtor_iban: string | null;
  debtor_name: string | null;
  creditor_iban: string | null;
  creditor_name: string | null;
};

const COLUMNS: readonly PartyColumn[] = [
  { table: 'transactions', column: 'debtor_iban' },
  { table: 'transactions', column: 'debtor_name' },
  { table: 'transactions', column: 'creditor_iban' },
  { table: 'transactions', column: 'creditor_name' },
  { table: 'transaction_events', column: 'debtor_iban' },
  { table: 'transaction_events', column: 'debtor_name' },
  { table: 'transaction_events', column: 'creditor_iban' },
  { table: 'transaction_events', column: 'creditor_name' },
];

const COLUMN_NAMES = ['debtor_iban', 'debtor_name', 'creditor_iban', 'creditor_name'] as const;

/**
 * Ferme le chemin de downgrade du chiffrement.
 *
 * Une simple tolerance applicative du clair permettrait a un acteur disposant
 * d'un droit d'ecriture SQL de remplacer un chiffre par un IBAN arbitraire. La
 * migration convertit donc d'abord tout l'historique, puis la base refuse toute
 * valeur qui n'est ni `NULL`, ni un chiffre versionne.
 */
export class EnforceEncryptedPartyFields2026072511000 implements MigrationInterface {
  name = 'EnforceEncryptedPartyFields2026072511000';
  private legacyDataKey?: Buffer;

  async up(queryRunner: QueryRunner): Promise<void> {
    this.installKey();

    try {
      await queryRunner.query(
        `ALTER TABLE "transactions" ADD COLUMN "encryption_version" smallint NOT NULL DEFAULT 0`,
      );
      await queryRunner.query(
        `ALTER TABLE "transaction_events" ADD COLUMN "encryption_version" smallint NOT NULL DEFAULT 0`,
      );

      await this.encryptLegacyRows(queryRunner, 'transactions');

      // Le changement ne modifie que la representation, jamais le fait logique.
      // Le declencheur append-only doit etre suspendu le temps de cette
      // conversion unique, dans la meme transaction que les contraintes.
      await queryRunner.query(
        `ALTER TABLE "transaction_events" DISABLE TRIGGER "trg_transaction_events_append_only"`,
      );
      await this.encryptLegacyRows(queryRunner, 'transaction_events');
      await queryRunner.query(
        `ALTER TABLE "transaction_events" ENABLE TRIGGER "trg_transaction_events_append_only"`,
      );

      for (const { table, column } of COLUMNS) {
        await queryRunner.query(
          `ALTER TABLE "${table}" ADD CONSTRAINT "${this.constraint(table, column)}" ` +
            `CHECK ("${column}" IS NULL OR "${column}" ~ ` +
            `'^enc\\.v1\\.[A-Za-z0-9_-]{1,32}\\.[A-Za-z0-9_-]+$')`,
        );
      }
      for (const table of ['transactions', 'transaction_events'] as const) {
        await queryRunner.query(
          `ALTER TABLE "${table}" ALTER COLUMN "encryption_version" SET DEFAULT 1`,
        );
        await queryRunner.query(
          `ALTER TABLE "${table}" ADD CONSTRAINT "CHK_${table}_encryption_version" ` +
            `CHECK ("encryption_version" = 1)`,
        );
      }
    } finally {
      FieldCipher.forgetKey();
      this.legacyDataKey = undefined;
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    this.installKey();

    try {
      for (const table of ['transaction_events', 'transactions'] as const) {
        await queryRunner.query(
          `ALTER TABLE "${table}" DROP CONSTRAINT "CHK_${table}_encryption_version"`,
        );
      }
      for (const { table, column } of [...COLUMNS].reverse()) {
        await queryRunner.query(
          `ALTER TABLE "${table}" DROP CONSTRAINT "${this.constraint(table, column)}"`,
        );
      }

      await this.decryptRows(queryRunner, 'transactions');
      await queryRunner.query(
        `ALTER TABLE "transaction_events" DISABLE TRIGGER "trg_transaction_events_append_only"`,
      );
      await this.decryptRows(queryRunner, 'transaction_events');
      await queryRunner.query(
        `ALTER TABLE "transaction_events" ENABLE TRIGGER "trg_transaction_events_append_only"`,
      );
      await queryRunner.query(`ALTER TABLE "transaction_events" DROP COLUMN "encryption_version"`);
      await queryRunner.query(`ALTER TABLE "transactions" DROP COLUMN "encryption_version"`);
    } finally {
      FieldCipher.forgetKey();
      this.legacyDataKey = undefined;
    }
  }

  private installKey(): void {
    const masterKey = process.env.SECURITY_MASTER_KEY ?? LOCAL_SECURITY_MASTER_KEY;
    const keySalt = process.env.SECURITY_KEY_SALT ?? DEFAULT_SECURITY_KEY_SALT;
    const currentKeyId = process.env.SECURITY_CURRENT_KEY_ID ?? LOCAL_SECURITY_KEY_ID;
    const keys = new Map<string, Buffer>([
      [currentKeyId, deriveDataEncryptionKey(decodeMasterKey(masterKey), keySalt)],
    ]);
    for (const previous of parsePreviousKeys(process.env.SECURITY_PREVIOUS_KEYS ?? '')) {
      keys.set(
        previous.keyId,
        deriveDataEncryptionKey(decodeMasterKey(previous.masterKey), keySalt),
      );
    }
    FieldCipher.useKeyRing(currentKeyId, keys);
    this.legacyDataKey = deriveLegacyDataEncryptionKey(
      process.env.SECURITY_LEGACY_MASTER_KEY ??
        process.env.SECURITY_MASTER_KEY ??
        LEGACY_LOCAL_SECURITY_MASTER_KEY,
      keySalt,
    );
  }

  private async encryptLegacyRows(
    queryRunner: QueryRunner,
    table: PartyColumn['table'],
  ): Promise<void> {
    const rows = (await queryRunner.query(
      `SELECT "id", "debtor_iban", "debtor_name", "creditor_iban", "creditor_name"
       FROM "${table}"
       WHERE "debtor_iban" IS NOT NULL
          OR "debtor_name" IS NOT NULL
          OR "creditor_iban" IS NOT NULL
          OR "creditor_name" IS NOT NULL`,
    )) as PartyRow[];

    for (const row of rows) {
      const values = COLUMN_NAMES.map((column) => {
        const value = row[column];
        if (value === null) return null;
        if (/^enc\.v1\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]+$/.test(value)) {
          return value;
        }
        const clear = value.startsWith('enc.v1.')
          ? FieldCipher.decryptLegacyV1(value, `${table}.${column}`, this.legacyDataKey as Buffer)
          : value;
        return FieldCipher.encrypt(clear, `${table}.${column}`);
      });
      await queryRunner.query(
        `UPDATE "${table}"
         SET "debtor_iban" = $1, "debtor_name" = $2, "creditor_iban" = $3, "creditor_name" = $4
         WHERE "id" = $5`,
        [...values, row.id],
      );
    }

    // Meme une ligne sans partie (faits posterieurs a l'ouverture) appartient
    // desormais au format strict : la version decrit la representation de la
    // ligne, pas seulement la presence d'un IBAN.
    await queryRunner.query(`UPDATE "${table}" SET "encryption_version" = 1`);
  }

  private async decryptRows(queryRunner: QueryRunner, table: PartyColumn['table']): Promise<void> {
    const rows = (await queryRunner.query(
      `SELECT "id", "debtor_iban", "debtor_name", "creditor_iban", "creditor_name"
       FROM "${table}"`,
    )) as PartyRow[];

    for (const row of rows) {
      const values = COLUMN_NAMES.map((column) =>
        FieldCipher.decrypt(row[column], `${table}.${column}`),
      );
      await queryRunner.query(
        `UPDATE "${table}"
         SET "debtor_iban" = $1, "debtor_name" = $2, "creditor_iban" = $3, "creditor_name" = $4
         WHERE "id" = $5`,
        [...values, row.id],
      );
    }
  }

  private constraint(table: PartyColumn['table'], column: PartyColumn['column']): string {
    return `CHK_${table}_${column}_encrypted`;
  }
}
