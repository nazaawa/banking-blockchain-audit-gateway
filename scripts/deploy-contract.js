#!/usr/bin/env node
/**
 * Deploie AuditAnchor sur le noeud configure et affiche l'adresse obtenue.
 *
 *   npm run contract:deploy
 *
 * Variables utilisees : BLOCKCHAIN_RPC_URL, BLOCKCHAIN_PRIVATE_KEY.
 * L'adresse est ecrite dans .contract-address (ignore par Git) afin que le
 * script de demarrage et les tests puissent la reprendre sans copier-coller.
 */
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');

// dotenv n'est qu'une commodite de developpement : en conteneur, les variables
// viennent de l'orchestrateur et le paquet n'est pas installe.
try {
  require('dotenv').config();
} catch {
  /* variables deja presentes dans l'environnement */
}

const ROOT = path.join(__dirname, '..');

/** L'artefact vit dans `src/` au developpement, dans `dist/` une fois compile. */
function loadArtifact() {
  const candidates = [
    path.join(ROOT, 'src', 'blockchain', 'contracts', 'AuditAnchor.json'),
    path.join(ROOT, 'dist', 'blockchain', 'contracts', 'AuditAnchor.json'),
  ];

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(
      `Artefact du contrat introuvable. Lancez d'abord : npm run contract:compile\n` +
        `Chemins explores :\n  - ${candidates.join('\n  - ')}`,
    );
  }
  return require(found);
}

const artifact = loadArtifact();

const RPC_URL = process.env.BLOCKCHAIN_RPC_URL ?? 'http://127.0.0.1:8545';
/** Compte #0 par defaut d'Anvil et du noeud Hardhat — chaine locale uniquement. */
const PRIVATE_KEY =
  process.env.BLOCKCHAIN_PRIVATE_KEY ??
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const network = await provider.getNetwork();
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const balance = await provider.getBalance(wallet.address);

  console.log(`Reseau    : chainId ${network.chainId} (${RPC_URL})`);
  console.log(`Deployeur : ${wallet.address} — ${ethers.formatEther(balance)} ETH`);

  if (balance === 0n) {
    throw new Error(`Le compte ${wallet.address} n'a aucun solde : deploiement impossible.`);
  }

  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const contract = await factory.deploy();
  console.log(`Transaction : ${contract.deploymentTransaction().hash}`);

  await contract.waitForDeployment();
  const address = await contract.getAddress();
  const receipt = await provider.getTransactionReceipt(contract.deploymentTransaction().hash);

  console.log(`\nAuditAnchor deploye`);
  console.log(`  adresse  : ${address}`);
  console.log(`  bloc     : ${receipt.blockNumber}`);
  console.log(`  gaz      : ${receipt.gasUsed}`);

  fs.writeFileSync(path.join(ROOT, '.contract-address'), `${address}\n`);
  console.log(`\nRenseignez BLOCKCHAIN_CONTRACT_ADDRESS=${address} dans votre .env`);
}

main().catch((error) => {
  console.error(`Deploiement en echec : ${error.message}`);
  process.exit(1);
});
