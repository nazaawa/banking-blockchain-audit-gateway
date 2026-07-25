import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { LEDGER_GUARD_STATEMENTS, LEDGER_TRIGGERS } from './ledger-guards';

/**
 * Verifie au demarrage que les garanties du journal sont en place.
 *
 * La migration les pose, mais `synchronize: true` — utilise en developpement et
 * par les tests d'integration — construit les tables a partir des seules
 * entites, sans declencheur. Le journal existerait alors sans equilibre impose
 * ni immuabilite : deux proprietes dont tout le reste depend.
 *
 * Meme raisonnement que pour le registre d'evenements : faire dependre une
 * garantie du chemin de provisionnement est un defaut en soi.
 */
@Injectable()
export class LedgerGuardsInstaller implements OnModuleInit {
  private readonly logger = new Logger(LedgerGuardsInstaller.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      const missing = await this.missingTriggers();
      if (missing.length === 0) {
        this.logger.log({ event: 'ledger.guards.present' });
        return;
      }

      await this.install();
      this.logger.warn({
        event: 'ledger.guards.installed',
        missing,
        detail:
          'Les declencheurs manquaient — schema probablement cree par synchronize. ' +
          'En production, provisionnez par migrations.',
      });
    } catch (error) {
      // Ne pas interrompre le demarrage : la base peut appartenir a un autre
      // role. Mais l'exploitation doit savoir que le journal tourne sans filet.
      this.logger.error({
        event: 'ledger.guards.missing',
        reason: error instanceof Error ? error.message : 'erreur inconnue',
        detail: 'JOURNAL NON PROTEGE : ecritures desequilibrees ou reecrites possibles.',
      });
    }
  }

  private async missingTriggers(): Promise<string[]> {
    const missing: string[] = [];

    for (const [trigger, table] of LEDGER_TRIGGERS) {
      const rows = await this.dataSource.query<unknown[]>(
        `SELECT 1 FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         WHERE t.tgname = $1 AND c.relname = $2 AND NOT t.tgisinternal`,
        [trigger, table],
      );
      if (rows.length === 0) missing.push(trigger);
    }

    return missing;
  }

  private async install(): Promise<void> {
    // Les declencheurs sont retires avant d'etre reposes : `CREATE TRIGGER`
    // n'accepte pas `OR REPLACE`, et une pose partielle laisserait un journal
    // a moitie protege.
    for (const [trigger, table] of LEDGER_TRIGGERS) {
      await this.dataSource.query(`DROP TRIGGER IF EXISTS "${trigger}" ON "${table}"`);
    }
    for (const statement of LEDGER_GUARD_STATEMENTS) {
      await this.dataSource.query(statement);
    }
  }
}
