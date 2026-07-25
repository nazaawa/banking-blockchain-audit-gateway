// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title AuditAnchor
 * @notice Registre d'ancrage de preuves d'integrite pour une passerelle bancaire.
 *
 * @dev Aucune donnee de paiement n'est ecrite ici. Le contrat ne conserve que la
 *      racine de Merkle d'un lot de transactions : un condensat de 32 octets d'ou
 *      l'on ne peut rien reconstituer. Les IBAN, montants et beneficiaires restent
 *      en base ; la chaine ne sert qu'a rendre leur alteration detectable.
 *
 *      Propriete centrale : un lot deja ancre ne peut jamais etre reecrit
 *      (`BatchAlreadyAnchored`). C'est ce qui distingue un registre d'audit d'une
 *      simple table de hashs — meme l'operateur du service ne peut pas revenir en
 *      arriere sur une preuve publiee.
 *
 *      Les preuves d'inclusion suivent la convention OpenZeppelin (paires triees,
 *      keccak256) : elles sont donc verifiables indifferemment sur la chaine via
 *      `verifyInclusion` ou hors chaine par n'importe quel tiers.
 */
contract AuditAnchor {
    struct Batch {
        bytes32 merkleRoot;
        uint64 leafCount;
        /// @dev Horodatage du bloc. Sert aussi de sentinelle : 0 == lot inexistant.
        uint64 anchoredAt;
        address submitter;
    }

    address public owner;

    /// @notice Comptes autorises a ancrer un lot.
    mapping(address => bool) public submitters;

    mapping(bytes32 => Batch) private _batches;
    bytes32[] private _batchIds;

    event BatchAnchored(
        bytes32 indexed batchId,
        bytes32 indexed merkleRoot,
        uint64 leafCount,
        uint64 anchoredAt,
        address indexed submitter
    );
    event SubmitterUpdated(address indexed submitter, bool allowed);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotAuthorized(address caller);
    error BatchAlreadyAnchored(bytes32 batchId);
    error UnknownBatch(bytes32 batchId);
    error EmptyBatch();
    error ZeroRoot();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotAuthorized(msg.sender);
        _;
    }

    modifier onlySubmitter() {
        if (!submitters[msg.sender]) revert NotAuthorized(msg.sender);
        _;
    }

    constructor() {
        owner = msg.sender;
        submitters[msg.sender] = true;
        emit OwnershipTransferred(address(0), msg.sender);
        emit SubmitterUpdated(msg.sender, true);
    }

    // -------------------------------------------------------------------------
    // Administration
    // -------------------------------------------------------------------------

    function setSubmitter(address account, bool allowed) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        submitters[account] = allowed;
        emit SubmitterUpdated(account, allowed);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // -------------------------------------------------------------------------
    // Ancrage
    // -------------------------------------------------------------------------

    /**
     * @notice Ancre la racine de Merkle d'un lot de transactions.
     * @param batchId    Identifiant du lot cote passerelle (UUID converti en bytes32).
     * @param merkleRoot Racine de l'arbre construit sur les empreintes des transactions.
     * @param leafCount  Nombre de transactions du lot, conserve pour l'audit.
     *
     * @dev Volontairement non modifiable : toute tentative de reecriture est rejetee.
     *      Corriger une erreur impose d'ancrer un nouveau lot, ce qui laisse une
     *      trace des deux etats.
     */
    function anchorBatch(bytes32 batchId, bytes32 merkleRoot, uint64 leafCount) external onlySubmitter {
        if (leafCount == 0) revert EmptyBatch();
        if (merkleRoot == bytes32(0)) revert ZeroRoot();
        if (_batches[batchId].anchoredAt != 0) revert BatchAlreadyAnchored(batchId);

        _batches[batchId] = Batch({
            merkleRoot: merkleRoot,
            leafCount: leafCount,
            anchoredAt: uint64(block.timestamp),
            submitter: msg.sender
        });
        _batchIds.push(batchId);

        emit BatchAnchored(batchId, merkleRoot, leafCount, uint64(block.timestamp), msg.sender);
    }

    // -------------------------------------------------------------------------
    // Consultation et verification
    // -------------------------------------------------------------------------

    function getBatch(bytes32 batchId) external view returns (Batch memory) {
        Batch memory batch = _batches[batchId];
        if (batch.anchoredAt == 0) revert UnknownBatch(batchId);
        return batch;
    }

    function isAnchored(bytes32 batchId) external view returns (bool) {
        return _batches[batchId].anchoredAt != 0;
    }

    function batchCount() external view returns (uint256) {
        return _batchIds.length;
    }

    function batchIdAt(uint256 index) external view returns (bytes32) {
        return _batchIds[index];
    }

    /**
     * @notice Verifie sur la chaine qu'une transaction appartient bien a un lot ancre.
     * @param leaf  Feuille de l'arbre, soit keccak256(empreinte de la transaction).
     * @param proof Chemin de hashs freres, de la feuille vers la racine.
     *
     * @dev La verification est aussi realisable hors chaine : la fonction existe
     *      pour qu'un tiers puisse s'en remettre uniquement au contrat, sans avoir
     *      a faire confiance a l'implementation de la passerelle.
     */
    function verifyInclusion(
        bytes32 batchId,
        bytes32 leaf,
        bytes32[] calldata proof
    ) external view returns (bool) {
        Batch memory batch = _batches[batchId];
        if (batch.anchoredAt == 0) revert UnknownBatch(batchId);
        return _processProof(proof, leaf) == batch.merkleRoot;
    }

    /// @dev Convention OpenZeppelin : les paires sont triees avant hachage, ce qui
    ///      rend la preuve independante de la position gauche/droite du frere.
    function _processProof(bytes32[] calldata proof, bytes32 leaf) private pure returns (bytes32) {
        bytes32 computed = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            computed = _hashPair(computed, proof[i]);
        }
        return computed;
    }

    function _hashPair(bytes32 a, bytes32 b) private pure returns (bytes32) {
        return a < b ? _efficientHash(a, b) : _efficientHash(b, a);
    }

    function _efficientHash(bytes32 a, bytes32 b) private pure returns (bytes32 value) {
        assembly {
            mstore(0x00, a)
            mstore(0x20, b)
            value := keccak256(0x00, 0x40)
        }
    }
}
