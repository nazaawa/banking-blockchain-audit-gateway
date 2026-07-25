import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

const TRIGGER_NAME = 'trg_transaction_events_append_only';
const TABLE_NAME = 'transaction_events';

/**
 * Garantit que la protection append-only est active, quel que soit le mode de
 * provisionnement du schema.
 *
 * La migration cree le declencheur, mais `synchronize: true` — utilise en
 * developpement et par les tests d'integration — construit la table a partir de
 * l'entite seule, sans lui. Le registre existait alors sans protection : une
 * simple requete pouvait reecrire un fait scelle.
 *
 * Faire dependre une propriete de securite du chemin de provisionnement est un
 * defaut en soi. Ce module verifie la presence du declencheur au demarrage et
 * l'installe s'il manque.
 */
@Injectable()
export class AppendOnlyGuardInstaller implements OnModuleInit {
  private readonly logger = new Logger(AppendOnlyGuardInstaller.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      if (await this.isInstalled()) {
        this.logger.log({ event: 'append-only.guard.present', table: TABLE_NAME });
        return;
      }

      await this.install();
      this.logger.warn({
        event: 'append-only.guard.installed',
        table: TABLE_NAME,
        detail:
          'Le declencheur manquait — schema probablement cree par synchronize. ' +
          'En production, provisionnez par migrations.',
      });
    } catch (error) {
      // Ne pas interrompre le demarrage : la base peut appartenir a un autre
      // role. Mais l'exploitation doit savoir que le registre tourne sans filet.
      this.logger.error({
        event: 'append-only.guard.missing',
        table: TABLE_NAME,
        reason: error instanceof Error ? error.message : 'erreur inconnue',
        detail: 'REGISTRE NON PROTEGE : les faits consignes sont modifiables.',
      });
    }
  }

  private async isInstalled(): Promise<boolean> {
    const rows = await this.dataSource.query(
      `SELECT 1 FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       WHERE t.tgname = $1 AND c.relname = $2 AND NOT t.tgisinternal`,
      [TRIGGER_NAME, TABLE_NAME],
    );

    return rows.length > 0;
  }

  private async install(): Promise<void> {
    await this.dataSource.query(
      `CREATE OR REPLACE FUNCTION "public"."transaction_events_append_only"()
       RETURNS trigger AS $$
       BEGIN
         IF TG_OP = 'DELETE' THEN
           RAISE EXCEPTION
             'transaction_events est append-only : suppression interdite (id=%)', OLD.id
             USING ERRCODE = 'restrict_violation';
         END IF;

         IF (to_jsonb(OLD) - 'anchor_status' - 'batch_id' - 'leaf_index' - 'merkle_proof')
            IS DISTINCT FROM
            (to_jsonb(NEW) - 'anchor_status' - 'batch_id' - 'leaf_index' - 'merkle_proof') THEN
           RAISE EXCEPTION
             'transaction_events est append-only : seules les colonnes d''ancrage sont modifiables (id=%)',
             OLD.id
             USING ERRCODE = 'restrict_violation';
         END IF;

         RETURN NEW;
       END;
       $$ LANGUAGE plpgsql`,
    );

    await this.dataSource.query(
      `CREATE TRIGGER "${TRIGGER_NAME}"
       BEFORE UPDATE OR DELETE ON "${TABLE_NAME}"
       FOR EACH ROW EXECUTE FUNCTION "public"."transaction_events_append_only"()`,
    );
  }
}
