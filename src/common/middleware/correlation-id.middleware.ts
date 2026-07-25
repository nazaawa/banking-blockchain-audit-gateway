import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { runWithRequestContext } from '../context/request-context';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

/** Format accepte pour un identifiant fourni par l'appelant (evite l'injection de log). */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]{8,128}$/;

declare module 'express-serve-static-core' {
  interface Request {
    correlationId?: string;
  }
}

/**
 * Attache un identifiant de correlation a chaque requete.
 *
 * L'identifiant fourni par l'appelant est reutilise s'il respecte un format sur,
 * sinon un UUID v4 est genere. Il est renvoye dans la reponse et propage via
 * AsyncLocalStorage a toutes les couches (service, client SOAP, audit).
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header(CORRELATION_ID_HEADER);
    const correlationId = incoming && SAFE_CORRELATION_ID.test(incoming) ? incoming : randomUUID();

    req.correlationId = correlationId;
    res.setHeader(CORRELATION_ID_HEADER, correlationId);

    runWithRequestContext({ correlationId, startedAt: Date.now() }, () => next());
  }
}
