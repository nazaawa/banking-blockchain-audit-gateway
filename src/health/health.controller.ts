import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Response } from 'express';
import { DataSource } from 'typeorm';
import { SoapClientService } from '../soap/soap-client.service';

type ComponentStatus = 'up' | 'down';

interface HealthReport {
  status: 'ok' | 'degraded';
  uptimeSeconds: number;
  timestamp: string;
  components: {
    database: { status: ComponentStatus; latencyMs?: number; error?: string };
    soapClient: { status: ComponentStatus };
  };
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly soapClient: SoapClientService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sonde de sante',
    description:
      'Verifie la connexion PostgreSQL et l initialisation du client SOAP. ' +
      'Retourne 503 si un composant est indisponible.',
  })
  @ApiOkResponse({ description: 'Tous les composants repondent' })
  @ApiServiceUnavailableResponse({ description: 'Au moins un composant est indisponible' })
  async check(@Res({ passthrough: true }) response: Response): Promise<HealthReport> {
    const [database, soapClient] = await Promise.all([
      this.checkDatabase(),
      this.checkSoapClient(),
    ]);

    const healthy = database.status === 'up' && soapClient.status === 'up';

    if (!healthy) {
      response.status(HttpStatus.SERVICE_UNAVAILABLE);
    }

    return {
      status: healthy ? 'ok' : 'degraded',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      components: { database, soapClient },
    };
  }

  private async checkDatabase(): Promise<HealthReport['components']['database']> {
    const startedAt = Date.now();
    try {
      await this.dataSource.query('SELECT 1');
      return { status: 'up', latencyMs: Date.now() - startedAt };
    } catch (error) {
      return {
        status: 'down',
        error: error instanceof Error ? error.message : 'erreur inconnue',
      };
    }
  }

  /**
   * Verifie uniquement que le client peut etre construit a partir du WSDL.
   * Aucune operation metier n'est appelee : la sonde ne doit pas solliciter
   * inutilement le fournisseur externe.
   */
  private async checkSoapClient(): Promise<HealthReport['components']['soapClient']> {
    return { status: (await this.soapClient.isReady()) ? 'up' : 'down' };
  }
}
