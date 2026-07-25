import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client, createClientAsync } from 'soap';
import { soapConfig } from '../config/configuration';
import { getCorrelationId } from '../common/context/request-context';
import { maskXml } from '../common/utils/masking.util';
import {
  SoapCommunicationException,
  SoapFaultException,
  SoapParsingException,
} from './exceptions/soap.exceptions';
import { SoapResponseMapper } from './soap-response.mapper';
import { SOAP_OPERATIONS, type AmountInWordsResult, type SoapExchange } from './soap.types';

/** Forme du tableau resolu par les methodes `*Async` de node-soap. */
type SoapCallResult = [unknown, string | undefined, unknown, string | undefined];

interface SoapErrorLike {
  message?: string;
  code?: string;
  body?: string;
  config?: { data?: string };
  response?: { status?: number; data?: unknown };
}

/**
 * Client du service public DataAccess « Number Conversion ».
 *
 * Le WSDL est embarque dans le depot (`wsdl/NumberConversion.wsdl`) et charge
 * depuis le disque par defaut : le demarrage de l'API ne depend donc d'aucun
 * appel reseau, et les tests restent hermetiques.
 *
 * Le client expose l'XML brut emis et recu afin que `SoapResponseMapper` fasse
 * reellement l'analyse de la reponse et que la piste d'audit soit complete.
 */
@Injectable()
export class SoapClientService implements OnModuleDestroy {
  private readonly logger = new Logger(SoapClientService.name);
  private clientPromise: Promise<Client> | null = null;

  constructor(
    @Inject(soapConfig.KEY)
    private readonly config: ConfigType<typeof soapConfig>,
    private readonly mapper: SoapResponseMapper,
  ) {}

  onModuleDestroy(): void {
    this.clientPromise = null;
  }

  /**
   * Convertit un montant en toutes lettres via l'operation `NumberToDollars`.
   *
   * @param amount montant decimal a convertir (ex. 1250.75)
   * @throws SoapFaultException si le service renvoie une enveloppe `<soap:Fault>`
   * @throws SoapCommunicationException si l'echange n'aboutit pas (timeout, reseau)
   * @throws SoapParsingException si la reponse est inexploitable
   */
  async convertAmountToWords(amount: number): Promise<AmountInWordsResult> {
    const operation = SOAP_OPERATIONS.numberToDollars;
    const exchange = await this.invoke(operation, { dNum: amount });
    const amountInWords = await this.mapper.mapNumberToDollars(exchange.rawResponse);

    this.logger.log({
      event: 'soap.call.succeeded',
      correlationId: getCorrelationId(),
      operation,
      durationMs: exchange.durationMs,
      attempts: exchange.attempts,
    });

    return { amountInWords, exchange };
  }

  /** Convertit un entier en toutes lettres via l'operation `NumberToWords`. */
  async convertNumberToWords(value: number): Promise<AmountInWordsResult> {
    const operation = SOAP_OPERATIONS.numberToWords;
    const exchange = await this.invoke(operation, { ubiNum: Math.trunc(Math.abs(value)) });
    const amountInWords = await this.mapper.mapNumberToWords(exchange.rawResponse);
    return { amountInWords, exchange };
  }

  /** Indique si le client SOAP est initialisable (utilise par la sonde de sante). */
  async isReady(): Promise<boolean> {
    try {
      await this.getClient();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Invoque une operation avec reprise sur erreur de communication uniquement.
   * Une faute SOAP est une reponse metier : elle n'est jamais rejouee.
   */
  private async invoke(operation: string, args: Record<string, unknown>): Promise<SoapExchange> {
    const correlationId = getCorrelationId();
    const maxAttempts = Math.max(1, this.config.maxRetries + 1);
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const startedAt = Date.now();

      try {
        const client = await this.getClient();
        const method = `${operation}Async` as keyof Client;
        const call = client[method] as (
          payload: unknown,
          options?: unknown,
        ) => Promise<SoapCallResult>;

        if (typeof call !== 'function') {
          throw new SoapParsingException(
            `Operation ${operation} absente du WSDL charge`,
            operation,
          );
        }

        this.logger.log({
          event: 'soap.call.started',
          correlationId,
          operation,
          attempt,
          endpoint: this.config.endpoint,
        });

        const [, rawResponse, , rawRequest] = await call.call(client, args, {
          timeout: this.config.timeoutMs,
        });

        if (!rawResponse) {
          throw new SoapParsingException(
            `Reponse SOAP vide pour l'operation ${operation}`,
            operation,
          );
        }

        return {
          operation,
          endpoint: this.config.endpoint,
          rawRequest: rawRequest ?? client.lastRequest ?? '',
          rawResponse,
          durationMs: Date.now() - startedAt,
          attempts: attempt,
        };
      } catch (error) {
        lastError = await this.normalizeError(error, operation, attempt);

        // Une faute SOAP ou une reponse inexploitable ne se rejoue pas.
        if (lastError instanceof SoapFaultException || lastError instanceof SoapParsingException) {
          throw lastError;
        }

        const isLastAttempt = attempt === maxAttempts;
        this.logger.warn({
          event: isLastAttempt ? 'soap.call.failed' : 'soap.call.retrying',
          correlationId,
          operation,
          attempt,
          maxAttempts,
          durationMs: Date.now() - startedAt,
          reason: (lastError as Error).message,
        });

        if (isLastAttempt) throw lastError;

        // Backoff lineaire : suffisant pour absorber une indisponibilite breve.
        await sleep(this.config.retryDelayMs * attempt);
      }
    }

    throw lastError ?? new SoapCommunicationException('Echec SOAP inconnu', operation);
  }

  /**
   * Traduit une erreur brute de node-soap/axios en exception du domaine.
   *
   * Un fournisseur SOAP signale une faute par un HTTP 500 portant une enveloppe
   * `<soap:Fault>` : node-soap la remonte comme une erreur de transport. Le
   * corps est donc repasse au mapper, qui applique les memes gardes de securite
   * et la meme normalisation 1.1/1.2 que sur le chemin nominal — plutot qu'une
   * extraction par expression reguliere, qui laisserait les entites XML
   * (`&gt;`, `&amp;`) non decodees dans le message rendu au client.
   */
  private async normalizeError(error: unknown, operation: string, attempt: number): Promise<Error> {
    if (
      error instanceof SoapFaultException ||
      error instanceof SoapParsingException ||
      error instanceof SoapCommunicationException
    ) {
      return error;
    }

    const err = (error ?? {}) as SoapErrorLike;
    const body = this.extractResponseBody(err);

    if (body && /Fault/i.test(body)) {
      try {
        const parsedBody = await this.mapper.parseEnvelope(body, operation);
        const fault = this.mapper.extractFault(parsedBody, body);
        if (fault) return new SoapFaultException(fault, operation, body);
      } catch (parsingError) {
        // Le corps a bien ete recu mais reste inexploitable (XML malforme,
        // construction interdite) : ce n'est pas un probleme de communication,
        // donc pas de reprise.
        if (parsingError instanceof SoapParsingException) return parsingError;
      }
    }

    const message = err.message ?? 'Erreur inconnue';
    const timedOut =
      err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || /timeout|timed out/i.test(message);

    const status = err.response?.status;
    const detail = status ? `HTTP ${status} — ${message}` : message;

    return new SoapCommunicationException(
      `Appel SOAP ${operation} en echec : ${detail}`,
      operation,
      timedOut,
      error,
      attempt,
    );
  }

  private extractResponseBody(err: SoapErrorLike): string | undefined {
    if (typeof err.body === 'string') return err.body;
    const data = err.response?.data;
    return typeof data === 'string' ? data : undefined;
  }

  /** Cree le client une seule fois ; une initialisation en echec n'est pas mise en cache. */
  private getClient(): Promise<Client> {
    this.clientPromise ??= this.createClient().catch((error: unknown) => {
      this.clientPromise = null;
      throw error;
    });
    return this.clientPromise;
  }

  private async createClient(): Promise<Client> {
    const source = this.resolveWsdlSource();

    this.logger.log({
      event: 'soap.client.initializing',
      wsdlSource: this.config.wsdlSource,
      wsdl: source,
      endpoint: this.config.endpoint,
    });

    try {
      const client = await createClientAsync(source, {
        endpoint: this.config.endpoint,
        disableCache: false,
        wsdl_options: { timeout: this.config.timeoutMs },
      });

      // Le WSDL local pointe vers l'adresse du fournisseur : on force l'endpoint
      // configure pour pouvoir viser un bouchon (mock) en recette.
      client.setEndpoint(this.config.endpoint);

      client.on('response', (responseBody: string) => {
        this.logger.debug({
          event: 'soap.response.raw',
          correlationId: getCorrelationId(),
          // Journalise l'XML masque : jamais d'IBAN complet dans les logs.
          xml: maskXml(String(responseBody ?? '')).slice(0, 2000),
        });
      });

      return client;
    } catch (error) {
      throw new SoapCommunicationException(
        `Initialisation du client SOAP impossible depuis ${source} : ${
          error instanceof Error ? error.message : 'erreur inconnue'
        }`,
        'createClient',
        false,
        error,
      );
    }
  }

  private resolveWsdlSource(): string {
    if (this.config.wsdlSource === 'remote') return this.config.wsdlUrl;

    if (!existsSync(this.config.wsdlPath)) {
      throw new SoapCommunicationException(
        `WSDL local introuvable : ${this.config.wsdlPath}. ` +
          `Verifiez la copie des assets (nest-cli.json) ou basculez SOAP_WSDL_SOURCE=remote.`,
        'createClient',
      );
    }

    return this.config.wsdlPath;
  }
}
