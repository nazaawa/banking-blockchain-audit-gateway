#!/usr/bin/env node
/**
 * Genere une cle d'API et l'entree de configuration correspondante.
 *
 *   node scripts/generate-api-key.js <keyId> <scope1,scope2> [libelle]
 *
 * Le secret n'est affiche qu'une fois : seule son empreinte SHA-256 est
 * destinee a la configuration. Le perdre impose d'en generer un nouveau.
 */
const { randomBytes, createHash } = require('node:crypto');

const allowedScopes = new Set([
  'transfers:read',
  'transfers:write',
  'refunds:write',
  'refunds:approve',
  'reconciliation:write',
  'ledger:read',
  'treasury:write',
  'anchors:read',
  'anchors:write',
  'simulator:write',
]);

const [keyId, scopes, ...labelParts] = process.argv.slice(2);
if ([keyId, scopes, ...labelParts].some((part) => part && /[|;]/.test(part))) {
  console.error('Les caracteres « | » et « ; » sont reserves aux separateurs.');
  process.exit(1);
}
if (!keyId || !scopes) {
  console.error('Usage : node scripts/generate-api-key.js <keyId> <scope1,scope2> [libelle]');
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{1,64}$/.test(keyId)) {
  console.error('keyId doit contenir 1 a 64 lettres, chiffres, tirets ou underscores.');
  process.exit(1);
}

const normalizedScopes = scopes
  .split(',')
  .map((scope) => scope.trim())
  .filter(Boolean);
const unknownScopes = normalizedScopes.filter((scope) => !allowedScopes.has(scope));
if (normalizedScopes.length === 0 || unknownScopes.length > 0) {
  console.error(
    unknownScopes.length > 0
      ? `Habilitation inconnue : ${unknownScopes.join(', ')}`
      : 'Au moins une habilitation est requise.',
  );
  console.error(`Habilitations disponibles : ${[...allowedScopes].join(', ')}`);
  process.exit(1);
}

const secret = randomBytes(32).toString('base64url');
const hash = createHash('sha256').update(secret, 'utf8').digest('hex');
const label = labelParts.join(' ') || keyId;
const normalized = [...new Set(normalizedScopes)].join(',');

console.log('\nA transmettre a l appelant (ne sera plus affiche) :');
console.log(`  Authorization: Bearer ${keyId}.${secret}\n`);
console.log('A ajouter a API_KEYS (separer les entrees par « ; ») :');
console.log(`  ${keyId}|${hash}|${normalized}|${label}\n`);
