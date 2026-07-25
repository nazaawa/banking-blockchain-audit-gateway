import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { hkdfSync } from 'node:crypto';
import { NonceManager, Wallet, type Signer } from 'ethers';
import { blockchainConfig, securityConfig } from '../config/configuration';
import type { KeyCustodyPort } from './key-custody.port';

/** Longueur d'une cle AES-256. */
const DATA_KEY_BYTES = 32;

/**
 * Garde locale : les secrets vivent dans la configuration du processus.
 *
 * C'est l'adaptateur de developpement, et il est honnete sur ce qu'il vaut. Il
 * remplit le contrat du port, ce qui permet au reste de l'application d'ignorer
 * completement ou vivent les secrets — mais il ne fournit **aucune** garantie de
 * garde : qui lit l'environnement lit les cles.
 *
 * ## La derivation, malgre tout
 *
 * La cle de chiffrement des donnees n'est pas prise telle quelle : elle est
 * derivee par HKDF depuis le secret maitre, avec une etiquette de domaine. Deux
 * usages distincts ne partagent donc jamais le meme materiel, et compromettre
 * l'un ne livre pas l'autre. C'est la seule propriete que cet adaptateur peut
 * offrir sans mentir sur le reste.
 */
@Injectable()
export class EnvKeyCustodyAdapter implements KeyCustodyPort, OnModuleInit {
  readonly custodyName = 'environnement local';

  private readonly logger = new Logger(EnvKeyCustodyAdapter.name);
  private dataKey?: Buffer;

  constructor(
    @Inject(blockchainConfig.KEY)
    private readonly blockchain: ConfigType<typeof blockchainConfig>,
    @Inject(securityConfig.KEY)
    private readonly security: ConfigType<typeof securityConfig>,
  ) {}

  onModuleInit(): void {
    this.logger.warn({
      event: 'key-custody.local',
      custody: this.custodyName,
      detail:
        'Les secrets sont lus depuis la configuration du processus. ' +
        'En production, cet adaptateur doit ceder la place a un KMS ou un HSM.',
    });
  }

  // Les trois methodes sont asynchrones **par contrat**, non par besoin : un
  // adaptateur KMS attend le reseau a chaque appel. Les rendre synchrones ici
  // obligerait a changer le port le jour ou l'on branche un vrai coffre.
  getAnchorSigner(provider?: unknown): Promise<Signer> {
    // NonceManager : ethers met en cache `eth_getTransactionCount`, ce qui
    // rejouerait le meme nonce sur deux ancrages rapproches.
    return Promise.resolve(
      new NonceManager(
        new Wallet(this.blockchain.privateKey, provider as ConstructorParameters<typeof Wallet>[1]),
      ),
    );
  }

  getAnchorAddress(): Promise<string> {
    return Promise.resolve(new Wallet(this.blockchain.privateKey).address);
  }

  getDataEncryptionKey(): Promise<Buffer> {
    // Derivee une fois : un KMS reel facturerait et ralentirait chaque appel,
    // et la cle vit de toute facon en memoire le temps du service.
    this.dataKey ??= Buffer.from(
      hkdfSync(
        'sha256',
        this.security.masterKey,
        this.security.keySalt,
        'iban-at-rest',
        DATA_KEY_BYTES,
      ),
    );
    return Promise.resolve(this.dataKey);
  }
}
