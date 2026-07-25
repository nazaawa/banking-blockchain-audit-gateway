import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import { authConfig } from '../config/configuration';
import { ALL_SCOPES } from './scopes';

const API_KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Identite portee par une cle, telle qu'exploitee par les journaux et l'audit. */
export interface ApiKeyIdentity {
  keyId: string;
  label: string;
  scopes: readonly string[];
}

interface RegisteredKey extends ApiKeyIdentity {
  /** Empreinte SHA-256 du secret. Le secret lui-meme n'est jamais conserve. */
  secretHash: Buffer;
}

/**
 * Authentification par cle d'API.
 *
 * ## Pourquoi des empreintes et non des secrets
 *
 * La configuration ne contient que le SHA-256 du secret. Une fuite du fichier
 * d'environnement — ou d'une variable exposee dans un journal de deploiement —
 * ne livre donc aucune cle utilisable. C'est la meme discipline que celle deja
 * appliquee au secret de webhook, et elle est ici indispensable puisque
 * certaines habilitations declenchent des mouvements de fonds.
 *
 * ## Format
 *
 * `API_KEYS` contient des entrees separees par `;` :
 *   `keyId|sha256Hex|scope1,scope2|libelle`
 *
 * Le separateur de champs est `|` et non `:` : les habilitations contiennent
 * elles-memes un `:` (`transfers:read`), et un separateur partage rendrait le
 * decoupage ambigu — le meme defaut que celui corrige sur la signature du
 * webhook. Ni `|` ni `,` n'apparaissent dans un identifiant, une empreinte
 * hexadecimale ou un nom d'habilitation.
 *
 * L'appelant presente `Authorization: Bearer <keyId>.<secret>`.
 *
 * ## Limites assumees
 *
 * Des cles statiques conviennent a une passerelle serveur-a-serveur. Elles ne
 * remplacent ni OAuth2 pour des acces utilisateur, ni mTLS pour une liaison
 * interbancaire — voir la section « Limites » du README.
 */
@Injectable()
export class ApiKeyService implements OnModuleInit {
  private readonly logger = new Logger(ApiKeyService.name);
  private readonly keys = new Map<string, RegisteredKey>();

  constructor(
    @Inject(authConfig.KEY)
    private readonly config: ConfigType<typeof authConfig>,
  ) {}

  onModuleInit(): void {
    const duplicateIds = new Set<string>();

    for (const entry of this.config.apiKeys) {
      const key = this.parseEntry(entry);
      if (!key || duplicateIds.has(key.keyId)) continue;

      if (this.keys.has(key.keyId)) {
        // Deux secrets portant le meme identifiant rendent une rotation
        // ambigue. Fermer les deux entrees evite que leur ordre decide laquelle
        // est active.
        this.keys.delete(key.keyId);
        duplicateIds.add(key.keyId);
        this.logger.error({
          event: 'auth.key.duplicate',
          keyId: key.keyId,
          detail: 'Toutes les entrees portant cet identifiant sont ignorees.',
        });
        continue;
      }

      this.keys.set(key.keyId, key);
    }

    if (!this.config.enabled) {
      this.logger.error({
        event: 'auth.disabled',
        detail:
          'AUTH_ENABLED=false — l API est ouverte, remboursements compris. ' +
          'Acceptable en developpement uniquement.',
      });
      return;
    }

    if (this.keys.size === 0) {
      this.logger.error({
        event: 'auth.no-keys',
        detail: 'Aucune cle d API declaree : toutes les requetes seront refusees.',
      });
      return;
    }

    this.logger.log({
      event: 'auth.keys.loaded',
      count: this.keys.size,
      keyIds: [...this.keys.keys()],
    });
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Resout un en-tete `Authorization` en identite.
   * Retourne `null` si l'en-tete est absent, mal forme, ou le secret invalide —
   * sans distinguer ces cas pour l'appelant.
   */
  authenticate(authorizationHeader: string | undefined): ApiKeyIdentity | null {
    const presented = this.extractBearer(authorizationHeader);
    if (!presented) return null;

    const separator = presented.indexOf('.');
    if (separator <= 0) return null;

    const keyId = presented.slice(0, separator);
    const secret = presented.slice(separator + 1);
    if (secret.length === 0) return null;

    const registered = this.keys.get(keyId);
    // Le hachage est calcule meme sans cle correspondante : le temps de reponse
    // ne doit pas reveler l'existence d'un identifiant.
    const candidate = createHash('sha256').update(secret, 'utf8').digest();
    if (!registered) return null;

    if (
      candidate.length !== registered.secretHash.length ||
      !timingSafeEqual(candidate, registered.secretHash)
    ) {
      return null;
    }

    return { keyId: registered.keyId, label: registered.label, scopes: registered.scopes };
  }

  private extractBearer(header: string | undefined): string | null {
    if (!header) return null;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return match ? match[1].trim() : null;
  }

  private parseEntry(entry: string): RegisteredKey | null {
    const parts = entry.split('|');
    const [rawKeyId, rawHash, scopes, rawLabel] = parts;
    const keyId = rawKeyId?.trim();
    const hash = rawHash?.trim();
    const label = rawLabel?.trim();

    if (
      parts.length < 3 ||
      parts.length > 4 ||
      !keyId ||
      !API_KEY_ID_PATTERN.test(keyId) ||
      !hash ||
      !/^[0-9a-fA-F]{64}$/.test(hash)
    ) {
      this.logger.error({
        event: 'auth.key.invalid',
        keyId: keyId || '(absent)',
        detail:
          'Entree ignoree : format, identifiant ou empreinte SHA-256 invalide. ' +
          'Un identifiant accepte uniquement lettres, chiffres, tirets et underscores.',
      });
      return null;
    }

    const granted = [
      ...new Set(
        (scopes ?? '')
          .split(',')
          .map((scope) => scope.trim())
          .filter(Boolean),
      ),
    ];

    const unknown = granted.filter((scope) => !ALL_SCOPES.includes(scope));
    if (unknown.length > 0) {
      this.logger.error({
        event: 'auth.key.unknown-scope',
        keyId,
        unknown,
        detail: 'Entree ignoree : une habilitation inconnue est probablement une faute de frappe.',
      });
      return null;
    }

    return {
      keyId,
      label: label || keyId,
      scopes: granted,
      secretHash: Buffer.from(hash.toLowerCase(), 'hex'),
    };
  }
}
