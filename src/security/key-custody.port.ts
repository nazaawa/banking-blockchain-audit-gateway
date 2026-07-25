import type { Signer } from 'ethers';

export const KEY_CUSTODY_PORT = Symbol('KEY_CUSTODY_PORT');

export interface DataEncryptionKeyRing {
  currentKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
}

/**
 * Garde des secrets cryptographiques.
 *
 * ## Ce que ce port change
 *
 * Avant lui, la cle privee d'ancrage etait lue depuis la configuration a deux
 * endroits, et la cle de chiffrement n'existait pas. Toute la surface applicative
 * pouvait donc atteindre le materiel cryptographique.
 *
 * Le port renverse la relation : l'application demande une **signature** ou une
 * **cle de donnees**, jamais la cle maitresse. Un adaptateur KMS peut alors ne
 * jamais la divulguer — c'est ce qui distingue un secret garde d'un secret
 * simplement range ailleurs.
 *
 * ## Ce qu'il ne change pas tout seul
 *
 * Avec l'adaptateur local, la cle reste en variable d'environnement. Le port
 * etablit la frontiere ; c'est l'adaptateur qui determine la garantie. Le dire
 * franchement importe : une architecture prete pour un KMS n'est pas un KMS.
 */
export interface KeyCustodyPort {
  /**
   * Signataire des transactions d'ancrage.
   *
   * Retourner un `Signer` plutot qu'une cle est deliberé : un KMS expose une
   * operation de signature, pas le secret. La signature reste ainsi la seule
   * chose que l'application obtient.
   */
  getAnchorSigner(provider?: unknown): Promise<Signer>;

  /** Adresse du compte d'ancrage, sans exposer la cle qui la produit. */
  getAnchorAddress(): Promise<string>;

  /**
   * Cle de chiffrement des donnees au repos, longue de 32 octets.
   *
   * Contrairement a la signature, le chiffrement symetrique impose que la cle
   * traverse le processus. Un KMS reel la delivrerait enveloppee, dechiffree en
   * memoire pour la duree du service — d'ou la mise en cache par l'adaptateur
   * plutot qu'une lecture a chaque appel.
   */
  getDataEncryptionKeyRing(): Promise<DataEncryptionKeyRing>;

  /** Nom de la garde active, journalise au demarrage. */
  readonly custodyName: string;
}
