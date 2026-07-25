import { Global, Module } from '@nestjs/common';
import { ApiKeyService } from './api-key.service';
import { ApiKeyGuard } from './guards/api-key.guard';

/**
 * Global : le garde est enregistre au niveau applicatif et doit pouvoir
 * resoudre `ApiKeyService` sans que chaque module l'importe.
 */
@Global()
@Module({
  providers: [ApiKeyService, ApiKeyGuard],
  exports: [ApiKeyService, ApiKeyGuard],
})
export class AuthModule {}
