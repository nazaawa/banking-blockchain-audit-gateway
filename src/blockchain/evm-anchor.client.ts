import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Contract, JsonRpcProvider, NonceManager, Wallet, isAddress } from 'ethers';
import { blockchainConfig } from '../config/configuration';
import artifact from './contracts/AuditAnchor.json';
import { uuidToBytes32 } from './fingerprint.util';

/** Resultat d'une inscription confirmee sur la chaine. */
export interface AnchorReceipt {
  txHash: string;
  blockNumber: string;
  gasUsed: string;
  chainId: string;
  contractAddress: string;
}

/** Lot tel que lu sur la chaine. */
export interface OnChainBatch {
  merkleRoot: string;
  leafCount: number;
  anchoredAt: Date;
  submitter: string;
}

/** L'echange avec le noeud n'a pas abouti (RPC injoignable, revert, timeout). */
export class BlockchainUnavailableException extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'BlockchainUnavailableException';
  }
}

/**
 * Client du contrat `AuditAnchor`.
 *
 * Isole entierement le reste de l'application d'ethers : le service d'ancrage
 * ne manipule que des types du domaine. Substituer une autre chaine ou un autre
 * registre revient a fournir une implementation alternative de cette classe.
 */
@Injectable()
export class EvmAnchorClient {
  private readonly logger = new Logger(EvmAnchorClient.name);
  private contract: Contract | null = null;
  private provider: JsonRpcProvider | null = null;

  constructor(
    @Inject(blockchainConfig.KEY)
    private readonly config: ConfigType<typeof blockchainConfig>,
  ) {}

  /** Inscrit la racine d'un lot et attend la confirmation. */
  async anchorBatch(
    batchId: string,
    merkleRoot: string,
    leafCount: number,
  ): Promise<AnchorReceipt> {
    const contract = this.getContract();
    const onChainId = uuidToBytes32(batchId);

    try {
      // Simulation prealable : un revert (lot deja ancre, compte non autorise)
      // est ainsi detecte sans consommer de gaz ni polluer le mempool.
      await contract.anchorBatch.staticCall(onChainId, merkleRoot, leafCount);

      const tx = await contract.anchorBatch(onChainId, merkleRoot, leafCount);
      this.logger.log({
        event: 'anchor.tx.submitted',
        batchId,
        txHash: tx.hash as string,
        merkleRoot,
        leafCount,
      });

      const receipt = await tx.wait(this.config.confirmations);
      if (!receipt) {
        throw new BlockchainUnavailableException(
          `Aucun recu obtenu pour la transaction ${tx.hash as string}`,
        );
      }

      return {
        txHash: receipt.hash as string,
        blockNumber: String(receipt.blockNumber),
        gasUsed: String(receipt.gasUsed),
        chainId: String(this.config.chainId),
        contractAddress: this.config.contractAddress,
      };
    } catch (error) {
      throw this.toDomainError(error, `Ancrage du lot ${batchId} en echec`);
    }
  }

  /** Relit un lot depuis la chaine — source de verite du controle d'integrite. */
  async getBatch(batchId: string): Promise<OnChainBatch | null> {
    const contract = this.getContract();
    const onChainId = uuidToBytes32(batchId);

    try {
      if (!(await contract.isAnchored(onChainId))) return null;

      const batch = (await contract.getBatch(onChainId)) as {
        merkleRoot: string;
        leafCount: bigint;
        anchoredAt: bigint;
        submitter: string;
      };

      return {
        merkleRoot: batch.merkleRoot,
        leafCount: Number(batch.leafCount),
        anchoredAt: new Date(Number(batch.anchoredAt) * 1000),
        submitter: batch.submitter,
      };
    } catch (error) {
      throw this.toDomainError(error, `Lecture du lot ${batchId} en echec`);
    }
  }

  /**
   * Fait verifier la preuve d'inclusion **par le contrat**.
   *
   * La verification est aussi realisee hors chaine ; la confronter au contrat
   * garantit qu'aucun defaut de notre implementation ne peut faire passer une
   * transaction absente du lot pour ancree.
   */
  async verifyInclusion(batchId: string, leaf: string, proof: readonly string[]): Promise<boolean> {
    const contract = this.getContract();
    try {
      return (await contract.verifyInclusion(uuidToBytes32(batchId), leaf, proof)) as boolean;
    } catch (error) {
      throw this.toDomainError(error, `Verification d inclusion en echec pour le lot ${batchId}`);
    }
  }

  /** Adresse du compte utilise pour soumettre les ancrages. */
  getSubmitterAddress(): string {
    return new Wallet(this.config.privateKey).address;
  }

  /** Sonde de sante : le noeud repond-il et le contrat est-il deploye ? */
  async isReady(): Promise<boolean> {
    try {
      const provider = this.getProvider();
      const code = await provider.getCode(this.config.contractAddress);
      return code !== '0x';
    } catch {
      return false;
    }
  }

  private getProvider(): JsonRpcProvider {
    this.provider ??= new JsonRpcProvider(this.config.rpcUrl, this.config.chainId, {
      staticNetwork: true,
    });
    return this.provider;
  }

  private getContract(): Contract {
    if (this.contract) return this.contract;

    if (!isAddress(this.config.contractAddress)) {
      throw new BlockchainUnavailableException(
        'BLOCKCHAIN_CONTRACT_ADDRESS est invalide. ' +
          `Deployez le contrat (npm run contract:deploy) puis renseignez l'adresse obtenue.`,
      );
    }

    // NonceManager : ethers met en cache `eth_getTransactionCount`, ce qui rejoue
    // le meme nonce sur deux ancrages rapproches. Le gestionnaire de nonce
    // serialise les envois et evite ce rejet « nonce too low ».
    const signer = new NonceManager(new Wallet(this.config.privateKey, this.getProvider()));

    this.contract = new Contract(this.config.contractAddress, artifact.abi, signer);
    return this.contract;
  }

  private toDomainError(error: unknown, context: string): Error {
    if (error instanceof BlockchainUnavailableException) return error;

    const err = error as { shortMessage?: string; message?: string; revert?: { name?: string } };
    const reason = err.revert?.name ?? err.shortMessage ?? err.message ?? 'erreur inconnue';

    return new BlockchainUnavailableException(`${context} : ${reason}`, error);
  }
}
