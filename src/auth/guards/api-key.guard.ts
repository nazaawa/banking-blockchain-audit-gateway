import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { getCorrelationId } from '../../common/context/request-context';
import type { ApiKeyIdentity } from '../api-key.service';
import { ApiKeyService } from '../api-key.service';
import { IS_PUBLIC } from '../decorators/public.decorator';
import { REQUIRED_SCOPES } from '../decorators/scopes.decorator';

declare module 'express-serve-static-core' {
  interface Request {
    apiKey?: ApiKeyIdentity;
  }
}

/**
 * Refus par defaut.
 *
 * Enregistre globalement : toute route non explicitement marquee `@Public()`
 * exige une cle valide. Une route ajoutee sans y penser est donc fermee, jamais
 * ouverte — c'est le sens du defaut qui compte sur une API qui deplace de
 * l'argent.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly apiKeys: ApiKeyService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    if (!this.apiKeys.enabled) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const identity = this.apiKeys.authenticate(request.header('authorization'));

    if (!identity) {
      this.logger.warn({
        event: 'auth.rejected',
        correlationId: getCorrelationId(),
        path: request.originalUrl ?? request.url,
        // Ni la cle presentee ni le motif exact : un journal ne doit pas aider
        // a distinguer « identifiant inconnu » de « secret errone ».
        detail: 'Cle d API absente ou invalide',
      });
      throw new UnauthorizedException({
        error: 'UNAUTHENTICATED',
        message: 'Cle d API absente ou invalide',
      });
    }

    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_SCOPES, [
      context.getHandler(),
      context.getClass(),
    ]);

    const missing = (required ?? []).filter((scope) => !identity.scopes.includes(scope));
    if (missing.length > 0) {
      this.logger.warn({
        event: 'auth.forbidden',
        correlationId: getCorrelationId(),
        keyId: identity.keyId,
        path: request.originalUrl ?? request.url,
        missing,
      });
      throw new ForbiddenException({
        error: 'INSUFFICIENT_SCOPE',
        message: `Habilitation manquante : ${missing.join(', ')}`,
      });
    }

    request.apiKey = identity;
    return true;
  }
}
