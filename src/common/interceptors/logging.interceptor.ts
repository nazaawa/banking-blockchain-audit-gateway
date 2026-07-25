import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import { getCorrelationId } from '../context/request-context';
import { maskDeep } from '../utils/masking.util';

/**
 * Journalise chaque echange HTTP entrant.
 *
 * Le corps de requete est systematiquement masque (`maskDeep`) : aucun IBAN
 * complet ni secret ne peut atteindre les logs applicatifs.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const correlationId = request.correlationId ?? getCorrelationId();
    const startedAt = Date.now();

    const base = {
      correlationId,
      method: request.method,
      path: request.originalUrl ?? request.url,
    };

    this.logger.log({
      ...base,
      event: 'request.received',
      body: this.describeBody(request.body),
    });

    return next.handle().pipe(
      tap({
        next: () => {
          this.logger.log({
            ...base,
            event: 'request.completed',
            statusCode: response.statusCode,
            durationMs: Date.now() - startedAt,
          });
        },
        error: (error: unknown) => {
          const statusCode =
            typeof error === 'object' && error !== null && 'status' in error
              ? (error as { status: number }).status
              : 500;

          this.logger.warn({
            ...base,
            event: 'request.failed',
            statusCode,
            durationMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : 'Erreur inconnue',
          });
        },
      }),
    );
  }

  private describeBody(body: unknown): unknown {
    if (body === undefined || body === null) return undefined;
    if (typeof body === 'object' && Object.keys(body).length === 0) return undefined;
    return maskDeep(body);
  }
}
