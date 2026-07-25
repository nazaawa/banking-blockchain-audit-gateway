import { keccak256, toUtf8Bytes } from 'ethers';
import { buildMerkleTree, getProof, hashPair, processProof, verifyProof } from './merkle.util';

const leaf = (value: string): string => keccak256(toUtf8Bytes(value));
const leaves = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => leaf(`transaction-${index}`));

describe('hashPair', () => {
  it('est commutatif : les paires sont triees avant hachage', () => {
    const [a, b] = [leaf('a'), leaf('b')];
    expect(hashPair(a, b)).toBe(hashPair(b, a));
  });

  it('distingue des paires differentes', () => {
    expect(hashPair(leaf('a'), leaf('b'))).not.toBe(hashPair(leaf('a'), leaf('c')));
  });
});

describe('buildMerkleTree', () => {
  it('refuse un lot vide', () => {
    expect(() => buildMerkleTree([])).toThrow(/sans feuille/);
  });

  it('refuse une feuille mal formee', () => {
    expect(() => buildMerkleTree(['0xdeadbeef'])).toThrow(/32 octets/);
  });

  it('reduit une feuille unique a elle-meme', () => {
    const single = leaves(1);
    const tree = buildMerkleTree(single);

    expect(tree.root).toBe(single[0]);
    expect(tree.layers).toHaveLength(1);
    expect(getProof(tree, 0)).toEqual([]);
  });

  it.each([2, 3, 4, 5, 7, 8, 16, 17, 31, 50])(
    'produit une racine stable et des preuves valides pour %i feuilles',
    (size) => {
      const batch = leaves(size);
      const tree = buildMerkleTree(batch);

      expect(tree.root).toMatch(/^0x[0-9a-f]{64}$/);
      // Racine deterministe : rejouer la construction doit redonner la meme valeur.
      expect(buildMerkleTree(batch).root).toBe(tree.root);

      for (let index = 0; index < size; index += 1) {
        expect(verifyProof(batch[index], getProof(tree, index), tree.root)).toBe(true);
      }
    },
  );

  it('la profondeur croit de facon logarithmique', () => {
    expect(buildMerkleTree(leaves(8)).layers).toHaveLength(4);
    expect(buildMerkleTree(leaves(16)).layers).toHaveLength(5);
    expect(buildMerkleTree(leaves(1024)).layers).toHaveLength(11);
  });

  it('deplacer une feuille vers un autre sous-arbre change la racine', () => {
    const batch = leaves(4);
    // Paires initiales : (0,1) et (2,3). En echangeant 1 et 2, on obtient
    // (0,2) et (1,3) : les deux sous-arbres changent.
    const permuted = [batch[0], batch[2], batch[1], batch[3]];

    expect(buildMerkleTree(permuted).root).not.toBe(buildMerkleTree(batch).root);
  });

  it('echanger deux freres d une meme paire ne change PAS la racine', () => {
    // Consequence assumee de la convention « paires triees » : au sein d une
    // paire, l ordre est perdu par construction. L arbre prouve l appartenance
    // d une transaction a un lot, pas son rang — ce qui suffit a l audit, et
    // rend les preuves independantes des positions gauche/droite.
    const batch = leaves(4);
    const swapped = [batch[1], batch[0], batch[2], batch[3]];

    expect(buildMerkleTree(swapped).root).toBe(buildMerkleTree(batch).root);
  });

  it('une seule feuille modifiee change la racine', () => {
    const batch = leaves(10);
    const tampered = [...batch];
    tampered[7] = leaf('transaction-7-falsifiee');

    expect(buildMerkleTree(tampered).root).not.toBe(buildMerkleTree(batch).root);
  });
});

describe('getProof', () => {
  it('refuse un indice hors bornes', () => {
    const tree = buildMerkleTree(leaves(4));

    expect(() => getProof(tree, 4)).toThrow(/hors bornes/);
    expect(() => getProof(tree, -1)).toThrow(/hors bornes/);
    expect(() => getProof(tree, 1.5)).toThrow(/hors bornes/);
  });

  it('produit une preuve de taille logarithmique', () => {
    const tree = buildMerkleTree(leaves(16));
    expect(getProof(tree, 0)).toHaveLength(4);
  });
});

describe('verifyProof', () => {
  it('rejette une feuille absente du lot', () => {
    const batch = leaves(8);
    const tree = buildMerkleTree(batch);
    const intruder = leaf('transaction-absente');

    expect(verifyProof(intruder, getProof(tree, 0), tree.root)).toBe(false);
  });

  it('rejette une preuve appartenant a une autre feuille', () => {
    const tree = buildMerkleTree(leaves(8));

    expect(verifyProof(tree.leaves[0], getProof(tree, 3), tree.root)).toBe(false);
  });

  it('rejette une preuve tronquee ou allongee', () => {
    const tree = buildMerkleTree(leaves(8));
    const proof = getProof(tree, 2);

    expect(verifyProof(tree.leaves[2], proof.slice(0, -1), tree.root)).toBe(false);
    expect(verifyProof(tree.leaves[2], [...proof, leaf('en-trop')], tree.root)).toBe(false);
  });

  it('rejette une preuve dont un maillon a ete altere', () => {
    const tree = buildMerkleTree(leaves(8));
    const proof = getProof(tree, 5);
    const tampered = [...proof];
    tampered[1] = leaf('maillon-falsifie');

    expect(verifyProof(tree.leaves[5], tampered, tree.root)).toBe(false);
  });

  it('rejette une racine alteree', () => {
    const tree = buildMerkleTree(leaves(8));

    expect(verifyProof(tree.leaves[0], getProof(tree, 0), leaf('fausse-racine'))).toBe(false);
  });

  it('ne leve jamais sur une entree malformee', () => {
    const tree = buildMerkleTree(leaves(4));

    expect(verifyProof('0xnope', [], tree.root)).toBe(false);
    expect(verifyProof(tree.leaves[0], ['pas-un-hash'], tree.root)).toBe(false);
  });

  it('est insensible a la casse hexadecimale', () => {
    const tree = buildMerkleTree(leaves(4));

    expect(
      verifyProof(tree.leaves[0], getProof(tree, 0), tree.root.toUpperCase().replace('0X', '0x')),
    ).toBe(true);
  });
});

describe('processProof', () => {
  it('retourne la feuille elle-meme pour une preuve vide', () => {
    const single = leaves(1);
    expect(processProof(single[0], [])).toBe(single[0]);
  });
});
