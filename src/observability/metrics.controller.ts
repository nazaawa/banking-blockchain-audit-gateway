import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { MetricsService } from './metrics.service';

@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  /**
   * Exposition Prometheus.
   *
   * Publique, comme les sondes : un collecteur ne porte pas de cle d'API, et
   * l'exposition ne contient aucune donnee nominative — des compteurs, des
   * montants agreges, jamais un IBAN ni une reference de transaction.
   *
   * En production, ce point d'entree se restreint au reseau de supervision,
   * pas par authentification applicative.
   */
  @Get()
  @Public()
  @ApiExcludeEndpoint()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(): Promise<string> {
    return this.metrics.scrape();
  }
}
