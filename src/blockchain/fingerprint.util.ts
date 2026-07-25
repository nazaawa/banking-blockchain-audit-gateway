import { randomBytes } from 'node:crypto';
import { concat, keccak256, toUtf8Bytes, zeroPadValue } from 'ethers';

/**
 * Scellement cryptographique d'une transaction.
 *
 * ## Pourquoi un sel
 *
 * Un IBAN a une entropie faible : le pays, la banque et le guichet suivent des
 * formats publics, et un montant se devine souvent. Ancrer `keccak256(document)`
 * exposerait donc la preuve a une attaque par force brute sur les preimages —
 * un observateur pourrait tester des documents plausibles jusqu'a retrouver le
 * hash publie, et donc lire les donnees du virement.
 *
 * Chaque transaction recoit donc un sel aleatoire de 32 octets, conserve en base
 * et jamais publie. L'empreinte devient `keccak256(sel ‖ document)`, ce qui rend
 * l'attaque irrealisable tout en laissant la verification possible pour qui
 * dispose d'un acces legitime a la base.
 *
 * ## Pourquoi un double hachage pour la feuille
 *
 * Dans un arbre de Merkle, un noeud interne est `keccak256(64 octets)`. Si une
 * feuille pouvait etre confondue avec un noeud interne, une preuve d'inclusion
 * pourrait etre forgee pour un element absent. OpenZeppelin recommande donc de
 * hacher les feuilles une seconde fois : `feuille = keccak256(empreinte)`.
 */

/** Longueur du sel, alignee sur la taille d'un mot EVM. */
const SALT_BYTES = 32;

/** Genere un sel aleatoire cryptographiquement sur. */
export function generateSalt(): string {
  return `0x${randomBytes(SALT_BYTES).toString('hex')}`;
}

/**
 * Calcule l'empreinte scellee d'un document canonique.
 *
 * @param salt        sel hexadecimal de 32 octets propre a la transaction
 * @param canonicalXml document XML canonique, valide contre son XSD
 */
export function computeFingerprint(salt: string, canonicalXml: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(salt)) {
    throw new Error('Le sel doit etre un hexadecimal de 32 octets');
  }
  return keccak256(concat([salt, toUtf8Bytes(canonicalXml)]));
}

/** Derive la feuille de Merkle a partir de l'empreinte (second hachage). */
export function toLeaf(fingerprint: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(fingerprint)) {
    throw new Error("L'empreinte doit etre un hexadecimal de 32 octets");
  }
  return keccak256(fingerprint);
}

/**
 * Convertit l'UUID d'un lot en `bytes32` pour l'identifier sur la chaine.
 * Les 16 octets de l'UUID sont completes a gauche par des zeros.
 */
export function uuidToBytes32(uuid: string): string {
  const hex = uuid.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error(`Identifiant de lot invalide : "${uuid}"`);
  }
  return zeroPadValue(`0x${hex}`, 32);
}
