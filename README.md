# Banking Integration & Blockchain Audit Gateway

Passerelle bancaire simulée qui reçoit un ordre de virement en REST/JSON, le transforme en **XML
canonique validé par XSD**, le soumet à un **service SOAP** décrit par un WSDL, le persiste dans
**PostgreSQL**, puis inscrit une **preuve cryptographique** sur une **blockchain** — afin que toute
altération ultérieure des données devienne détectable.

> La blockchain ne porte **aucun** paiement et **aucune** donnée bancaire. Elle sert de registre
> d'audit inviolable : seule une racine de Merkle de 32 octets y est publiée, dont on ne peut rien
> reconstituer.

---

## Chaîne de traitement

```
POST /api/v1/transfers  (JSON)
   │
   ├─ 1. Validation          IBAN (ISO 13616 + clé MOD 97-10), montant, devise, libellé SEPA
   ├─ 2. Règles métier       devise autorisée, plafond, comptes distincts
   ├─ 3. Transformation XML  document canonique TransferRequest
   ├─ 4. Validation XSD      transfer-request.xsd — rejet 422 si non conforme
   ├─ 5. Idempotence         Idempotency-Key → rejeu sans nouvel appel externe
   ├─ 6. Référence unique    TRF-YYYYMMDD-XXXXXXXX (CSPRNG, Crockford base32)
   ├─ 7. Persistance         PostgreSQL, statut PENDING  ← AVANT tout appel externe
   ├─ 8. Appel SOAP          NumberToDollars (WSDL local, timeout, reprises)
   ├─ 9. Analyse XML         parseur durci → détection <soap:Fault> 1.1 / 1.2
   ├─ 10. Statut terminal    COMPLETED ou FAILED
   ├─ 11. Scellement         TransferRecord canonique → validé XSD → keccak256(sel ‖ document)
   └─ 12. Audit              échanges consignés, payloads XML masqués
   │
   └─→ 201 Created

[asynchrone, périodique]
   └─ Lot de N transactions → arbre de Merkle → racine publiée sur la chaîne
                            → preuve d'inclusion persistée par transaction

GET /api/v1/transfers/{ref}/verification
   └─ Reconstruit · revalide · recalcule l'empreinte · confronte à la chaîne
```

Deux principes structurants :

- **La transaction est enregistrée avant l'appel externe.** Si le SOAP échoue, l'API répond 502/504
  mais renvoie la `reference` : la demande reste consultable avec le statut `FAILED`.
- **L'ancrage est asynchrone.** Une écriture on-chain prend de quelques secondes à plusieurs
  minutes ; l'inclure dans le cycle HTTP reproduirait le défaut que l'on évite déjà sur le SOAP.
  Le scellement, lui, est synchrone et instantané.

---

## Stack

| Besoin | Choix |
| --- | --- |
| API | NestJS 11 (Express 5) |
| Base de données | PostgreSQL 16 |
| ORM | TypeORM 0.3 (repository dédié, verrouillage optimiste) |
| Client SOAP | `soap` (node-soap) sur WSDL embarqué |
| Analyse XML | `xml2js` avec gardes anti-XXE |
| Validation XSD | `xmllint-wasm` — libxml2 en WebAssembly |
| Blockchain | Chaîne EVM locale (Anvil / nœud Hardhat) + contrat Solidity |
| Client chaîne | `ethers` v6 |
| Documentation | Swagger / OpenAPI 3 |
| Tests | Jest + Supertest — **223 tests** |
| Conteneurisation | Docker multi-stage + Docker Compose |

`xmllint-wasm` a été retenu plutôt que `libxmljs` (compilation native) ou `xsd-schema-validator`
(dépendance à une JVM) : c'est le même moteur que l'outil `xmllint` de référence, sans rien à
compiler, identique du poste de développement à l'image Alpine.

---

## Démarrage

### Option A — Docker Compose

```bash
cp .env.example .env
docker compose up --build
```

Compose orchestre l'ordre : PostgreSQL et la chaîne démarrent, le contrat est déployé
(`contract-deployer`, exécution unique), puis l'API démarre.

Anvil étant déterministe, le compte #0 déployant sa première transaction obtient toujours
`0x5FbDB2315678afecb367f032d93F642f64180aa3` — l'API connaît donc l'adresse à l'avance.

### Option B — En local

Trois terminaux, ou trois commandes en arrière-plan.

```bash
# 0. Base de données (une fois)
createdb banking_soap && createdb banking_soap_test
psql -d banking_soap      -c 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp";'
psql -d banking_soap_test -c 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp";'

npm install
cp .env.example .env

# 1. Chaîne EVM locale
npm run chain:node

# 2. Compilation et déploiement du contrat
npm run contract:compile
npm run contract:deploy      # affiche l'adresse → BLOCKCHAIN_CONTRACT_ADDRESS dans .env

# 3. Passerelle
npm run start:dev
```

- API : http://localhost:3000/api/v1
- Swagger : http://localhost:3000/api/docs
- Santé : http://localhost:3000/api/v1/health

Pour travailler sans chaîne, `BLOCKCHAIN_ENABLED=false` : les transactions restent scellées
(empreinte calculée, altération détectable localement) mais ne sont jamais publiées.

---

## API

### Initier un virement

```bash
curl -X POST http://localhost:3000/api/v1/transfers \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: cmd-2026-0042' \
  -d '{
    "debtorIban":   "fr76 3000 6000 0112 3456 7890 189",
    "debtorName":   "Societe Kongo SARL",
    "creditorIban": "DE89370400440532013000",
    "creditorName": "ACME GmbH",
    "amount":       1250.75,
    "currency":     "EUR",
    "endToEndLabel":"Facture 2026-0042"
  }'
```

`201 Created` — réponse réelle du service public DataAccess :

```json
{
  "reference": "TRF-20260725-02AC53WQ",
  "status": "COMPLETED",
  "debtorIbanMasked": "FR76****0189",
  "creditorIbanMasked": "DE89****3000",
  "creditorName": "ACME GmbH",
  "amount": 1250.75,
  "currency": "EUR",
  "amountInWords": "one thousand two hundred and fifty dollars and seventy five cents",
  "soap": { "operation": "NumberToDollars", "durationMs": 1865, "attempts": 1 },
  "correlationId": "6f8724f3-104b-4423-8e55-affd30d1b812",
  "processedAt": "2026-07-25T10:30:31.748Z"
}
```

Les IBAN ne sont **jamais** restitués en clair : les champs s'appellent `debtorIbanMasked` /
`creditorIbanMasked` pour que le contrat soit explicite.

### Vérifier l'intégrité

```bash
curl http://localhost:3000/api/v1/transfers/TRF-20260725-02AC53WQ/verification
```

```json
{
  "verdict": "VERIFIED",
  "checks": {
    "recordRebuilt": true,
    "xsdValid": true,
    "fingerprintMatches": true,
    "merkleProofValid": true,
    "onChainRootMatches": true,
    "onChainInclusionVerified": true
  },
  "sealedFingerprint": "0xc9aac0902151e80b92b17d8b9a42486f51af83f3dde6f09dbf2817d9a033a508",
  "recomputedFingerprint": "0xc9aac0902151e80b92b17d8b9a42486f51af83f3dde6f09dbf2817d9a033a508",
  "batch": {
    "merkleRoot": "0x32d7753f648c6d98633dd4e98cc4c8c506c8ca6f8d8d5268e8722cecb45de83b",
    "txHash": "0xfb4b24e2afc319e682bf88cee5b75e8e49237643f9926c4e9923391934b00210",
    "blockNumber": "10",
    "chainId": "31337"
  },
  "findings": [
    "Les donnees en base correspondent exactement a l empreinte scellee.",
    "Inclusion confirmee par le contrat 0x5FbD…0aa3 (chaine 31337), racine publiee dans la transaction 0xfb4b…0210."
  ]
}
```

| Verdict | Signification |
| --- | --- |
| `VERIFIED` | Données intactes, inclusion confirmée par le contrat |
| `PENDING_ANCHOR` | Données intactes, ancrage pas encore effectué |
| `TAMPERED` | **Altération détectée** |
| `NOT_SEALED` | Jamais scellée — aucune preuve disponible |
| `CHAIN_UNAVAILABLE` | Contrôles hors chaîne concluants, nœud injoignable |

### Autres points d'entrée

| Méthode | Route | Rôle |
| --- | --- | --- |
| `GET` | `/transfers` | Liste paginée, filtres `status` et `currency` |
| `GET` | `/transfers/{ref}` | Statut d'un virement |
| `GET` | `/transfers/{ref}/audit` | Piste d'audit (payloads XML masqués) |
| `GET` | `/anchors/batches` | Lots d'ancrage et leurs transactions blockchain |
| `GET` | `/anchors/batches/{id}` | Détail d'un lot |
| `POST` | `/anchors/batches` | Ancrage immédiat (exploitation / démonstration) |
| `GET` | `/anchors/statistics` | Répartition par état d'ancrage |
| `GET` | `/health` | PostgreSQL, client SOAP, schémas XSD, blockchain |

---

## Le modèle de preuve

### Ce qui est scellé

Quand une transaction atteint un état terminal, la passerelle produit un document
`TransferRecord` — l'état final complet, résultat de l'appel SOAP inclus — le valide contre
`transfer-record.xsd`, puis calcule :

```
empreinte = keccak256( sel(32 octets) ‖ documentXmlCanonique )
```

**Le document n'est pas conservé.** Il est reconstruit depuis la base au moment de la vérification,
et c'est précisément cette reconstruction qui rend l'altération détectable.

#### Pourquoi un sel

Un IBAN a une entropie faible : pays, banque et guichet suivent des formats publics, et un montant
se devine souvent. Publier `keccak256(document)` exposerait la preuve à une attaque par force brute
sur les préimages — il suffirait de tester des documents plausibles jusqu'à retrouver le condensat.

Chaque transaction reçoit donc un sel aléatoire de 32 octets, conservé en base et **jamais publié**.
Conséquence secondaire utile : deux virements identiques n'exposent pas la même empreinte.

#### Pourquoi la canonicité est critique

L'empreinte porte sur les octets exacts du document. Le sérialiseur est donc déterministe par
construction plutôt que canonicalisé après coup (C14N) : ordre imposé par le XSD, indentation fixe,
fins de ligne LF, montants toujours à 2 décimales (`1250.7` → `1250.70`), dates ISO 8601 UTC,
éléments optionnels vides omis. L'attribut `version` du document permettra de rejouer la
vérification d'archives anciennes si le format évolue.

### Ce qui est ancré

Ancrer chaque virement individuellement ferait croître le coût linéairement. Les transactions sont
donc regroupées en lots, et seule la **racine de Merkle** du lot est publiée : un mot de 32 octets,
que le lot contienne 1 ou 1000 virements.

```
                     racine  ← publiée sur la chaîne
                    /      \
               h(01)        h(23)
              /    \        /    \
          feuille0  f1     f2     f3     feuille = keccak256(empreinte)
```

Chaque transaction conserve son **chemin de hashs frères** (preuve d'inclusion), de taille
logarithmique. La vérification recalcule la racine depuis la feuille et la compare à celle publiée.

Deux conventions rendent les preuves vérifiables indifféremment hors chaîne et par le contrat :

- **Paires triées** — `hash(a,b) = keccak256(min ‖ max)`, donc pas besoin de mémoriser les positions
  gauche/droite. Conséquence assumée : l'ordre au sein d'une paire est perdu. L'arbre prouve
  l'appartenance d'une transaction à un lot, pas son rang — ce qui suffit à l'audit.
- **Promotion du nœud orphelin** — sur un niveau impair, le dernier nœud remonte tel quel. Le
  dupliquer permettrait de forger une preuve d'inclusion pour un élément absent.
- **Double hachage des feuilles** — `feuille = keccak256(empreinte)`, recommandation OpenZeppelin
  contre la confusion entre une feuille et un nœud interne.

### Le contrat `AuditAnchor`

```solidity
function anchorBatch(bytes32 batchId, bytes32 merkleRoot, uint64 leafCount) external onlySubmitter;
function verifyInclusion(bytes32 batchId, bytes32 leaf, bytes32[] calldata proof) external view returns (bool);
```

Deux propriétés en font un registre d'audit plutôt qu'une table de hashs :

1. **Immuabilité** — un lot déjà ancré ne peut jamais être réécrit (`BatchAlreadyAnchored`).
   Corriger une erreur impose d'ancrer un nouveau lot, ce qui laisse trace des deux états.
2. **Contrôle d'accès** — seuls les comptes déclarés `submitter` peuvent ancrer.

`verifyInclusion` permet à un tiers de s'en remettre au seul contrat, sans faire confiance à
l'implémentation de la passerelle.

### Pourquoi la blockchain est indispensable ici

Comparer l'empreinte recalculée à une empreinte stockée dans la même base ne prouve rien : qui
modifie une ligne peut modifier l'empreinte. La chaîne apporte le point de référence que l'opérateur
ne contrôle plus.

Voici la défense en profondeur, telle que réellement exercée sur cette implémentation :

| Ce que fait l'attaquant (accès total en écriture à la base) | Contrôle qui cède | Verdict |
| --- | --- | --- |
| Modifie l'IBAN du bénéficiaire | `fingerprintMatches` → `false` | `TAMPERED` |
| …et réaligne l'empreinte stockée | `merkleProofValid` → `false` | `TAMPERED` |
| …et forge une racine de Merkle cohérente | `onChainRootMatches` → `false` | `TAMPERED` |

À la dernière ligne, tous les contrôles internes passent — et la chaîne tranche seule. Falsifier un
virement supposerait de réécrire l'historique de la chaîne.

---

## Sécurité et confidentialité

### Où vivent les IBAN complets

| Destination | IBAN complet ? |
| --- | --- |
| Table `transactions` | **Oui** — nécessaire à l'exécution du virement |
| Document scellé (transitoire) | **Oui** — c'est l'objet de la preuve, jamais publié |
| Réponses HTTP | Non — masqué `FR76****0189` |
| Logs applicatifs | Non — masqué |
| Table `audit_logs` | Non — masqué puis tronqué |
| Blockchain | Non — seule une racine de Merkle y figure |

Vérifié en exécution réelle : sur 445 lignes de log produites par un virement complet, **zéro**
occurrence d'IBAN en clair.

Le masquage opère à trois niveaux (`src/common/utils/masking.util.ts`) : IBAN (`FR76****0189`),
secrets (`[REDACTED]` intégral), et **texte libre / XML par détection de motif** — un IBAN glissé
dans un commentaire ou une balise non prévue est masqué quand même.

### Durcissement des parseurs

Un parseur XML est une surface d'attaque classique. Avant tout parsing, la couche SOAP rejette
`<!DOCTYPE`, `<!ENTITY` (XXE et *billion laughs*), `<?xml-stylesheet`, et toute réponse au-delà de
`SOAP_MAX_RESPONSE_BYTES`. Le rejet est explicite plutôt que délégué au comportement par défaut
d'une dépendance tierce.

Côté génération, l'échappement XML joue un double rôle : conformité du document, et neutralisation
d'une injection. Un nom de bénéficiaire contenant `</creditorName>` ne peut pas restructurer le
document — donc pas davantage détourner l'empreinte scellée.

### Autres mesures

- `ValidationPipe` en `whitelist` + `forbidNonWhitelisted` — un champ hors contrat est un signe
  d'erreur d'intégration, pas un extra à ignorer ;
- jeu de caractères SEPA imposé sur les libellés ;
- validation d'environnement au démarrage, **sans jamais reproduire une valeur sensible** dans le
  message d'erreur (la clé privée est signalée « valeur masquée ») ;
- `helmet`, identifiant de corrélation validé par motif (anti-injection de log) ;
- image Docker en utilisateur `node`, `dumb-init` pour la propagation de `SIGTERM`.

---

## Modèle de données

**`transactions`** — référence et clé d'idempotence uniques, statut, IBAN, montant `numeric(18,2)`,
métadonnées SOAP, puis les champs de scellement : `fingerprint`, `fingerprint_salt`,
`record_format_version`, `sealed_at`, `anchor_status`, `batch_id`, `leaf_index`, `merkle_proof`
(jsonb). Verrouillage optimiste via `@VersionColumn`.

**`audit_logs`** — sens de l'échange (`DOCUMENT_VALIDATED`, `OUTBOUND_REQUEST`, `INBOUND_RESPONSE`,
`INBOUND_FAULT`, `COMMUNICATION_ERROR`), payload masqué et tronqué, durée, code de faute,
corrélation. Écriture *best-effort* : un échec d'audit ne fait jamais échouer la transaction métier.

**`anchor_batches`** — statut, racine de Merkle, nombre de feuilles, `chain_id`, adresse du contrat,
`tx_hash`, numéro de bloc, gaz consommé, tentatives, dernière erreur.

### Contrats XSD

| Schéma | Rôle |
| --- | --- |
| `transfer-request.xsd` | Demande — **validé à l'exécution** avant l'appel SOAP |
| `transfer-record.xsd` | Enregistrement scellé — **validé à l'exécution** avant hachage |
| `transfer-response.xsd` | Contrat de sortie de l'API — documentaire |

La clé de contrôle MOD 97-10 n'étant pas exprimable en XSD 1.0, elle reste vérifiée par
`IsIbanConstraint` : le XSD ne valide que la structure.

---

## Tests

```bash
npm test          # 165 tests unitaires
npm run test:e2e  #  58 tests d'intégration (PostgreSQL requis)
npm run test:cov  # couverture
```

Les tests e2e utilisent `banking_soap_test`, bouchonnent le client SOAP, et remplacent la chaîne par
un registre en mémoire qui reproduit fidèlement le contrat (refus de réécriture, vérification
d'inclusion par recalcul). Ils sont donc **déterministes et hors ligne**, y compris pour les
scénarios de faute, de timeout et de falsification.

Couverture notable :

- **Merkle** — tailles 1 à 1024 dont impaires, preuve tronquée / allongée / altérée, feuille
  étrangère, racine falsifiée, déterminisme, propriété des paires triées ;
- **Scellement** — sensibilité au centime près, unicité des sels, rejet des sels malformés,
  caractères non-ASCII ;
- **Canonicité** — indépendance vis-à-vis de l'ordre de construction de l'objet, injection XML ;
- **Intégrité** — 5 champs falsifiés indépendamment, plus les trois niveaux d'attaque en cascade ;
- **Résilience** — chaîne injoignable distinguée d'une altération, remise en file après échec.

### Défauts réels trouvés par les tests

Cinq bugs authentiques ont été détectés et corrigés pendant le développement :

1. `<soap:Fault/>` vide non reconnu comme faute (xml2js le rend en chaîne vide) ;
2. après résolution d'une course d'idempotence, la transaction gagnante était retraitée — soit un
   **second appel SOAP pour un seul virement** ;
3. entités XML non décodées (`---&gt;`) dans le message d'erreur rendu au client ;
4. **collision de nonce** sur deux ancrages rapprochés : `ethers` met en cache
   `eth_getTransactionCount`, d'où un rejet « nonce too low ». Corrigé par `NonceManager` ;
5. le test « l'ordre des feuilles change la racine » était **faux** — avec des paires triées,
   échanger deux frères ne change rien. La propriété a été documentée plutôt que contournée.

---

## Validation en conditions réelles

Exercé contre le vrai service DataAccess, une chaîne Anvil/Hardhat locale et un bouchon SOAP :

| Scénario | Résultat observé |
| --- | --- |
| Virement nominal, service public réel | `201 COMPLETED` · *"one thousand two hundred and fifty dollars and seventy five cents"* · 1865 ms |
| Rejeu avec la même `Idempotency-Key` | Référence identique, aucun second appel SOAP |
| Timeout SOAP (`SOAP_TIMEOUT_MS=100`) | `504 SOAP_TIMEOUT` · 3 tentatives · `FAILED` |
| Faute SOAP 1.1 et 1.2 (bouchon HTTP 500) | `502 SOAP_FAULT` · aucune reprise · faute persistée |
| Arbre de Merkle vs `verifyInclusion` du contrat | Concordance sur 1, 2, 3, 5, 8 et 17 feuilles ; intrus rejeté |
| Réécriture d'un lot déjà ancré | Rejetée — `BatchAlreadyAnchored` |
| Ancrage par un compte non autorisé | Rejeté — `NotAuthorized` |
| Ancrage de 3 virements | 1 transaction chaîne, bloc 10, **121 159 gaz** |
| Falsification en base (3 niveaux) | `TAMPERED` aux trois niveaux (voir tableau plus haut) |
| Fuite d'IBAN (logs + audit) | Aucune |

---

## Arborescence

```
├── contracts/AuditAnchor.sol       # Registre d'ancrage (Solidity)
├── scripts/                        # Compilation (solc) et déploiement (ethers)
├── src/
│   ├── transactions/               # Domaine métier — orchestration du virement
│   ├── soap/                       # Couche anti-corruption SOAP
│   │   ├── soap-client.service.ts  #   transport, timeout, reprises
│   │   ├── soap-response.mapper.ts #   analyse XML, normalisation des fautes
│   │   └── wsdl/                   #   WSDL embarqué (aucun appel réseau au boot)
│   ├── xml/                        # Sérialisation canonique + validation XSD
│   │   ├── transfer-xml.builder.ts
│   │   └── xsd-validator.service.ts
│   ├── blockchain/                 # Scellement, ancrage Merkle, vérification
│   │   ├── fingerprint.util.ts     #   sel + keccak256 + dérivation de feuille
│   │   ├── merkle.util.ts          #   arbre et preuves, compatibles OpenZeppelin
│   │   ├── anchor.service.ts       #   lots, planification, reprises
│   │   ├── evm-anchor.client.ts    #   ethers ↔ contrat
│   │   └── integrity-verification.service.ts
│   ├── audit/ · common/ · config/ · database/ · health/
├── schemas/                        # transfer-request · transfer-record · transfer-response
├── samples/                        # Enveloppes SOAP réelles + payloads hostiles
├── test/                           # transfers.e2e-spec · integrity.e2e-spec
└── docker-compose.yml · Dockerfile
```

---

## Limites assumées

Ce dépôt est une démonstration d'intégration, pas un service de paiement.

- **Aucune authentification.** Une mise en production exigerait OAuth2/mTLS, une autorisation par
  scope et une limitation de débit.
- **Aucun débit réel.** Le service SOAP convertit un montant en lettres ; il ne contacte aucun
  système de règlement.
- **Clé privée en variable d'environnement.** Acceptable sur une chaîne locale jetable dont le
  compte #0 est public. En production, la signature relèverait d'un HSM ou d'un KMS.
- **Chaîne locale.** Un registre réellement inviolable suppose une chaîne publique ou un consortium
  dont l'opérateur ne contrôle pas les validateurs. L'architecture est prête — `EvmAnchorClient`
  isole entièrement ethers — mais un testnet public introduirait une dépendance à un faucet et à un
  fournisseur RPC.
- **Traitement synchrone du virement.** Le modèle cible serait une file de messages avec reprise
  durable plutôt qu'un appel bloquant dans le cycle HTTP.
- **IBAN stockés en clair.** En production, chiffrement au repos ou coffre à jetons.
- **Pas de purge.** La piste d'audit croît indéfiniment ; une politique de rétention serait requise.
- **Pas de vérification en masse.** Le contrôle est unitaire ; un audit de bout en bout supposerait
  une revérification par lot.
