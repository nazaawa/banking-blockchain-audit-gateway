import { concat, keccak256 } from 'ethers';

/**
 * Arbre de Merkle compatible OpenZeppelin.
 *
 * Deux conventions rendent les preuves verifiables indifferemment hors chaine
 * (ici) et sur la chaine (`AuditAnchor.verifyInclusion`) :
 *
 *  1. **Paires triees** — `hash(a, b) = keccak256(min(a,b) ‖ max(a,b))`. La preuve
 *     se reduit alors a la liste des freres : nul besoin de memoriser les
 *     positions gauche/droite.
 *  2. **Promotion du noeud orphelin** — sur un niveau de cardinalite impaire, le
 *     dernier noeud remonte tel quel plutot que d'etre double. Dupliquer une
 *     feuille permettrait de forger une preuve d'inclusion pour un element absent.
 */

export interface MerkleTree {
  root: string;
  leaves: string[];
  /** Niveaux du bas (feuilles) vers le haut (racine). */
  layers: string[][];
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

function assertBytes32(value: string, label: string): void {
  if (!BYTES32.test(value)) {
    throw new Error(`${label} doit etre un hexadecimal de 32 octets (recu: "${value}")`);
  }
}

/** Hache une paire de noeuds apres tri lexicographique de leurs valeurs. */
export function hashPair(a: string, b: string): string {
  const [left, right] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return keccak256(concat([left, right]));
}

/**
 * Construit l'arbre a partir des feuilles fournies.
 * L'ordre des feuilles est significatif : il fixe l'indice de chaque transaction
 * dans le lot et doit donc etre persiste.
 */
export function buildMerkleTree(leaves: string[]): MerkleTree {
  if (leaves.length === 0) {
    throw new Error('Impossible de construire un arbre de Merkle sans feuille');
  }
  leaves.forEach((leaf, index) => assertBytes32(leaf, `La feuille ${index}`));

  const layers: string[][] = [[...leaves]];

  while (layers[layers.length - 1].length > 1) {
    const current = layers[layers.length - 1];
    const next: string[] = [];

    for (let i = 0; i < current.length; i += 2) {
      // Noeud orphelin en fin de niveau impair : il remonte inchange.
      next.push(i + 1 < current.length ? hashPair(current[i], current[i + 1]) : current[i]);
    }

    layers.push(next);
  }

  return { root: layers[layers.length - 1][0], leaves: [...leaves], layers };
}

/**
 * Chemin de hashs freres permettant de recalculer la racine depuis une feuille.
 * Un arbre a feuille unique produit une preuve vide : la feuille *est* la racine.
 */
export function getProof(tree: MerkleTree, leafIndex: number): string[] {
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= tree.leaves.length) {
    throw new Error(
      `Indice de feuille hors bornes : ${leafIndex} (l'arbre compte ${tree.leaves.length} feuilles)`,
    );
  }

  const proof: string[] = [];
  let index = leafIndex;

  for (let level = 0; level < tree.layers.length - 1; level += 1) {
    const layer = tree.layers[level];
    // XOR 1 : passe de l'indice pair a son voisin impair, et inversement.
    const siblingIndex = index ^ 1;

    // Absent uniquement lorsque le noeud a ete promu faute de frere.
    if (siblingIndex < layer.length) proof.push(layer[siblingIndex]);

    index = Math.floor(index / 2);
  }

  return proof;
}

/** Recalcule la racine a partir d'une feuille et de sa preuve. */
export function processProof(leaf: string, proof: readonly string[]): string {
  assertBytes32(leaf, 'La feuille');
  return proof.reduce((computed, sibling, index) => {
    assertBytes32(sibling, `L'element ${index} de la preuve`);
    return hashPair(computed, sibling);
  }, leaf);
}

/** Verifie qu'une feuille appartient bien a l'arbre de racine donnee. */
export function verifyProof(leaf: string, proof: readonly string[], root: string): boolean {
  try {
    return processProof(leaf, proof).toLowerCase() === root.toLowerCase();
  } catch {
    return false;
  }
}
