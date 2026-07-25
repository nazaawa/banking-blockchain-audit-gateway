import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { DataSource } from 'typeorm';

const PREFIX = 'gateway_';

interface AmountGaugeRow {
  currency: string;
  value: number;
}

interface CountGaugeRow {
  value: number;
}

/**
 * Metriques d'exploitation.
 *
 * ## Le choix des signaux
 *
 * Un compteur de requetes HTTP ne dit rien de ce systeme : il indique que l'API
 * repond, pas qu'elle est juste. Les mesures retenues ci-dessous repondent aux
 * seules questions qu'un exploitant se pose reellement ici :
 *
 * - **Combien devons-nous, et a qui ?** — une dette qui grimpe signale un
 *   fournisseur en difficulte bien avant que les clients ne se plaignent.
 * - **Nos preuves sont-elles publiees ?** — des faits non ancres qui
 *   s'accumulent signifient que l'audit prend du retard sur la realite.
 * - **La comptabilite tient-elle ?** — un desequilibre non nul est une
 *   corruption, pas une derive : il justifie une alerte immediate.
 *
 * ## Pourquoi certaines sont calculees a la demande
 *
 * Les soldes et les files d'attente sont lus en base au moment du grattage. Les
 * maintenir en memoire supposerait que chaque ecriture pense a les mettre a
 * jour — un compteur qui derive silencieusement est pire qu'une absence de
 * compteur, parce qu'on lui fait confiance.
 */
@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);
  readonly registry = new Registry();

  /** Duree des appels au back-office, mesuree a l'emission. */
  readonly soapDuration = new Histogram({
    name: `${PREFIX}soap_duration_seconds`,
    help: 'Duree des appels SOAP au back-office bancaire',
    labelNames: ['operation', 'outcome'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  });

  readonly refundsFailed = new Counter({
    name: `${PREFIX}refunds_failed_total`,
    help: 'Tentatives de remboursement en echec',
    labelNames: ['retryable'] as const,
  });

  readonly anchorBatches = new Counter({
    name: `${PREFIX}anchor_batches_total`,
    help: 'Lots d ancrage traites',
    labelNames: ['status'] as const,
  });

  private readonly debtOutstanding = new Gauge({
    name: `${PREFIX}debt_outstanding`,
    help: 'Montant du au payeur, non encore rembourse',
    labelNames: ['currency'] as const,
  });

  private readonly eventsUnanchored = new Gauge({
    name: `${PREFIX}events_unanchored`,
    help: 'Faits consignes en attente de publication sur la chaine',
  });

  private readonly ledgerImbalance = new Gauge({
    name: `${PREFIX}ledger_imbalance`,
    help: 'Ecart entre debits et credits du journal — doit valoir zero',
    labelNames: ['currency'] as const,
  });

  private readonly casesOpen = new Gauge({
    name: `${PREFIX}cases_open`,
    help: 'Dossiers d exception ouverts, en attente de traitement humain',
  });

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {
    collectDefaultMetrics({ register: this.registry, prefix: PREFIX });

    // Enregistrement un a un : les etiquettes different d'une metrique a
    // l'autre, et les reunir dans un tableau effacerait ce typage.
    this.registry.registerMetric(this.soapDuration);
    this.registry.registerMetric(this.refundsFailed);
    this.registry.registerMetric(this.anchorBatches);
    this.registry.registerMetric(this.debtOutstanding);
    this.registry.registerMetric(this.eventsUnanchored);
    this.registry.registerMetric(this.ledgerImbalance);
    this.registry.registerMetric(this.casesOpen);
  }

  /**
   * Rend l'exposition Prometheus, apres avoir rafraichi les jauges.
   *
   * Une erreur de collecte n'interrompt pas l'exposition : perdre une jauge est
   * moins grave que perdre toute la supervision au moment ou elle sert le plus.
   */
  async scrape(): Promise<string> {
    try {
      await this.refreshGauges();
    } catch (error) {
      this.logger.error({
        event: 'metrics.refresh.failed',
        reason: error instanceof Error ? error.message : 'erreur inconnue',
      });
    }

    return this.registry.metrics();
  }

  private async refreshGauges(): Promise<void> {
    this.debtOutstanding.reset();
    this.ledgerImbalance.reset();

    // Dette envers les payeurs : ce que le journal dit devoir, par devise.
    const debts = await this.dataSource.query<AmountGaugeRow[]>(
      `SELECT entry.currency AS currency,
              COALESCE(SUM(CASE WHEN line.direction = 'CREDIT' THEN line.amount
                                ELSE -line.amount END), 0)::float8 AS value
         FROM journal_lines line
         JOIN journal_entries entry ON entry.id = line.entry_id
        WHERE line.account = 'PAYER_PAYABLE'
        GROUP BY entry.currency`,
    );

    for (const row of debts) {
      this.debtOutstanding.set({ currency: row.currency }, row.value);
    }

    // Desequilibre : tous comptes confondus, par devise.
    const imbalances = await this.dataSource.query<AmountGaugeRow[]>(
      `SELECT entry.currency AS currency,
              COALESCE(SUM(CASE WHEN line.direction = 'DEBIT' THEN line.amount
                                ELSE -line.amount END), 0)::float8 AS value
         FROM journal_lines line
         JOIN journal_entries entry ON entry.id = line.entry_id
        GROUP BY entry.currency`,
    );

    for (const row of imbalances) {
      this.ledgerImbalance.set({ currency: row.currency }, row.value);
    }

    const [{ value: pending } = { value: 0 }] = await this.dataSource.query<CountGaugeRow[]>(
      `SELECT COUNT(*)::int AS value
         FROM transaction_events
        WHERE anchor_status = 'PENDING'`,
    );
    this.eventsUnanchored.set(pending);

    const [{ value: open } = { value: 0 }] = await this.dataSource.query<CountGaugeRow[]>(
      `SELECT COUNT(*)::int AS value
         FROM transactions
        WHERE case_status = 'MANUAL_REVIEW'`,
    );
    this.casesOpen.set(open);
  }
}
