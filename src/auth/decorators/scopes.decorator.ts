import { SetMetadata } from '@nestjs/common';
import type { Scope } from '../scopes';

export const REQUIRED_SCOPES = 'auth:scopes';

/** Exige une ou plusieurs habilitations. Toutes doivent etre detenues. */
export const RequireScopes = (...scopes: Scope[]) => SetMetadata(REQUIRED_SCOPES, scopes);
