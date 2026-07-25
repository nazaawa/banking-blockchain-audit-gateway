import { Controller, Get, HttpCode, HttpStatus, Inject, Res } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Response } from 'express';
import { DataSource } from 'typeorm';
import { Public } from '../auth/decorators/public.decorator';
import { SoapClientService } from '../soap/soap-client.service';
import { XsdValidatorService } from '../xml/xsd-validator.service';
import { EvmAnchorClient } from '../blockchain/evm-anchor.client';
import { blockchainConfig } from '../config/configuration';

type ComponentStatus = 'up' | 'down';

interface HealthReport {
  status: 'ok' | 'degraded';
  uptimeSeconds: number;
  timestamp: string;
  components: {
    database: { status: ComponentStatus; latencyMs?: number; error?: string };
    soapClient: { status: ComponentStatus };
    xsdSchemas: { status: ComponentStatus };
    blockchain: { status: ComponentStatus; enabled: boolean; contractAddress?: string };
  };
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly soapClient: SoapClientService,
    private readonly xsdValidator: XsdValidatorService,
    private readonly anchorClient: EvmAnchorClient,
    @Inject(blockchainConfig.KEY)
    private readonly chain: ConfigType<typeof blockchainConfig>,
  ) {}

  /**
   * Vivacite : le processus repond-il ?
   *
   * Ne consulte **aucune** dependance, deliberement. Un orchestrateur redemarre
   * le conteneur quand cette sonde echoue : la faire dependre de PostgreSQL ou
   * de la chaine reviendrait a redemarrer en boucle un service parfaitement
   * sain parce qu'un tiers est indisponible — et a aggraver la panne, chaque
   * redemarrage rouvrant des connexions vers un composant deja en difficulte.
   */
  @Get('live')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sonde de vivacite',
    description:
      'Repond 200 tant que le processus fonctionne. Ne consulte aucune ' +
      'dependance : un echec doit signifier « redemarrez-moi », rien d autre.',
  })
  live(): { status: 'ok'; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  /**
   * Aptitude : le service peut-il traiter du trafic ?
   *
   * PostgreSQL est requis — sans base, aucune requete metier n'aboutit. La
   * chaine ne l'est **pas** : l'ancrage est asynchrone et rattrapable, un noeud
   * injoignable degrade la publication sans empecher d'encaisser ni de payer.
   * Retirer le service du trafic pour cela couperait un systeme qui fonctionne.
   */
  @Get('ready')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sonde d aptitude au trafic',
    description:
      'Exige PostgreSQL, le client SOAP et les schemas XSD. La blockchain en ' +
      'est exclue : son indisponibilite retarde la publication des preuves, ' +
      'elle n empeche pas de traiter les paiements.',
  })
  @ApiServiceUnavailableResponse({ description: 'Une dependance requise est indisponible' })
  async ready(
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ status: 'ok' | 'degraded'; components: Record<string, ComponentStatus> }> {
    const [database, soapClient] = await Promise.all([
      this.checkDatabase(),
      this.checkSoapClient(),
    ]);
    const xsdSchemas: ComponentStatus = this.xsdValidator.isReady() ? 'up' : 'down';

    const ready = database.status === 'up' && soapClient.status === 'up' && xsdSchemas === 'up';

    if (!ready) response.status(HttpStatus.SERVICE_UNAVAILABLE);

    return {
      status: ready ? 'ok' : 'degraded',
      components: { database: database.status, soapClient: soapClient.status, xsdSchemas },
    };
  }

  @Get()
  // Sonde de supervision : aucune donnee metier, doit rester joignable.
  @Public()
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
    const [database, soapClient, blockchain] = await Promise.all([
      this.checkDatabase(),
      this.checkSoapClient(),
      this.checkBlockchain(),
    ]);

    const xsdSchemas: { status: ComponentStatus } = {
      status: this.xsdValidator.isReady() ? 'up' : 'down',
    };

    // L'ancrage desactive n'est pas une panne : c'est un mode d'exploitation
    // assume, ou les faits restent scelles sans etre publies.
    const healthy =
      database.status === 'up' &&
      soapClient.status === 'up' &&
      xsdSchemas.status === 'up' &&
      (!blockchain.enabled || blockchain.status === 'up');

    if (!healthy) {
      response.status(HttpStatus.SERVICE_UNAVAILABLE);
    }

    return {
      status: healthy ? 'ok' : 'degraded',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      components: { database, soapClient, xsdSchemas, blockchain },
    };
  }

  /** Verifie que le noeud repond et que le contrat d ancrage est bien deploye. */
  private async checkBlockchain(): Promise<HealthReport['components']['blockchain']> {
    if (!this.chain.enabled) return { status: 'up', enabled: false };

    return {
      status: (await this.anchorClient.isReady()) ? 'up' : 'down',
      enabled: true,
      contractAddress: this.chain.contractAddress,
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
