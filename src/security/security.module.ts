import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { Inject, Logger } from '@nestjs/common';
import { EnvKeyCustodyAdapter } from './env-key-custody.adapter';
import { FieldCipher } from './field-cipher';
import { KEY_CUSTODY_PORT, type KeyCustodyPort } from './key-custody.port';

/**
 * Garde des secrets et chiffrement au repos.
 *
 * Le module est global : la garde est unique par definition, et laisser chaque
 * module fournir la sienne ouvrirait la porte a des cles divergentes.
 *
 * L'installation de la cle a lieu ici, au demarrage, parce que les
 * transformateurs TypeORM sont synchrones et ne peuvent pas l'attendre.
 */
@Global()
@Module({
  providers: [
    EnvKeyCustodyAdapter,
    { provide: KEY_CUSTODY_PORT, useExisting: EnvKeyCustodyAdapter },
  ],
  exports: [KEY_CUSTODY_PORT],
})
export class SecurityModule implements OnModuleInit {
  private readonly logger = new Logger(SecurityModule.name);

  constructor(
    @Inject(KEY_CUSTODY_PORT)
    private readonly custody: KeyCustodyPort,
  ) {}

  async onModuleInit(): Promise<void> {
    const keyRing = await this.custody.getDataEncryptionKeyRing();
    FieldCipher.useKeyRing(keyRing.currentKeyId, keyRing.keys);
    this.logger.log({
      event: 'field-cipher.ready',
      custody: this.custody.custodyName,
      algorithm: 'aes-256-gcm',
      currentKeyId: keyRing.currentKeyId,
      readableKeys: keyRing.keys.size,
    });
  }
}
