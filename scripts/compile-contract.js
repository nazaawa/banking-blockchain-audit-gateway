#!/usr/bin/env node
/**
 * Compile contracts/AuditAnchor.sol et ecrit l'artefact (ABI + bytecode) dans
 * src/blockchain/contracts/AuditAnchor.json.
 *
 * L'artefact est versionne : l'API n'embarque donc pas `solc` a l'execution, et
 * l'image Docker reste legere. Relancer ce script apres toute modification du
 * contrat (`npm run contract:compile`).
 */
const fs = require('node:fs');
const path = require('node:path');
const solc = require('solc');

const ROOT = path.join(__dirname, '..');
const SOURCE_NAME = 'AuditAnchor.sol';
const SOURCE_PATH = path.join(ROOT, 'contracts', SOURCE_NAME);
const OUTPUT_PATH = path.join(ROOT, 'src', 'blockchain', 'contracts', 'AuditAnchor.json');

const source = fs.readFileSync(SOURCE_PATH, 'utf8');

const input = {
  language: 'Solidity',
  sources: { [SOURCE_NAME]: { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));

const diagnostics = output.errors ?? [];
const errors = diagnostics.filter((d) => d.severity === 'error');
for (const warning of diagnostics.filter((d) => d.severity !== 'error')) {
  console.warn(`[solc] ${warning.formattedMessage.trim()}`);
}
if (errors.length > 0) {
  for (const error of errors) console.error(`[solc] ${error.formattedMessage.trim()}`);
  process.exit(1);
}

const contract = output.contracts[SOURCE_NAME].AuditAnchor;
const artifact = {
  contractName: 'AuditAnchor',
  compiler: { name: 'solc', version: solc.version() },
  abi: contract.abi,
  bytecode: `0x${contract.evm.bytecode.object}`,
};

fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(artifact, null, 2)}\n`);

const sizeKb = (artifact.bytecode.length / 2 / 1024).toFixed(2);
console.log(`AuditAnchor compile (solc ${solc.version()})`);
console.log(`  ABI      : ${artifact.abi.length} entrees`);
console.log(`  Bytecode : ${sizeKb} Kio`);
console.log(`  Artefact : ${path.relative(ROOT, OUTPUT_PATH)}`);
