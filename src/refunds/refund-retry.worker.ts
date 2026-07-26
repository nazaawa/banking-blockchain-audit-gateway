import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { mobileMoneyConfig } from '../config/configuration';
import { RefundsService } from './refunds.service';

const REFUND_RETRY_JOB = 'refund-retry-worker';

/**
 * Reprend les remboursements dont l'issue fournisseur reste indeterminee.
 *
 * Le fournisseur deduplique avec la cle stable portee par le dossier : plusieurs
 * instances peuvent donc declencher une reprise sans produire deux sorties de
 * fonds. Le verrou local evite seulement de superposer deux passages dans un
 * meme processus.
 */
@Injectable()
export class RefundRetryWorker implements OnModuleInit {
  private readonly logger = new Logger(RefundRetryWorker.name);
  private running = false;

  constructor(
    private readonly refunds: RefundsService,
    private readonly scheduler: SchedulerRegistry,
    @Inject(mobileMoneyConfig.KEY)
    private readonly config: ConfigType<typeof mobileMoneyConfig>,
  ) {}

  onModuleInit(): void {
    if (!this.config.refundWorkerEnabled) return;

    const interval = setInterval(() => {
      void this.runOnce().catch((error: unknown) => {
        this.logger.error({
          event: 'refund-retry.worker.failed',
          reason: error instanceof Error ? error.message : 'erreur inconnue',
        });
      });
    }, this.config.refundWorkerIntervalMs);

    this.scheduler.addInterval(REFUND_RETRY_JOB, interval);
    this.logger.log({
      event: 'refund-retry.worker.started',
      intervalMs: this.config.refundWorkerIntervalMs,
    });
  }

  async runOnce(): Promise<{ examined: number; completed: number }> {
    if (this.running) return { examined: 0, completed: 0 };

    this.running = true;
    try {
      return await this.refunds.retryPending();
    } finally {
      this.running = false;
    }
  }
}
