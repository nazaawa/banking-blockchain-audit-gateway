# Banking Integration & Blockchain Audit Gateway

Passerelle bancaire simulée qui reçoit un paiement **Mobile Money**, attend la confirmation signée
d'un agrégateur, déclenche l'intégration bancaire **SOAP**, rapproche les deux jambes dans
**PostgreSQL**, consigne chaque fait métier dans un **registre append-only**, en tire une
**comptabilité en partie double**, puis publie sur une **blockchain** une **preuve cryptographique**
du dossier une fois celui-ci clos.

> La blockchain ne porte **aucun** paiement et **aucune** donnée bancaire. Elle sert de registre
> d'audit inviolable : seule une racine de Merkle de 32 octets y est publiée, dont on ne peut rien
> reconstituer.

---

## Chaîne de traitement

```
POST /api/v1/mobile-money/transactions
   │
   ├─ 1. Validation          opérateur, MSISDN E.164, IBAN, montant et devise
   ├─ 2. Idempotence         Idempotency-Key → une seule collecte
   ├─ 3. Agrégateur          référence AGG-*, état PENDING
   ├─ 4. Registre            PAYMENT_INITIATED — les parties y sont consignées
   └─→ 201 Created           aucun appel bancaire à ce stade

POST /api/v1/webhooks/mobile-money
   │
   ├─ 5. Authentification    HMAC SHA-256, comparaison en temps constant
   ├─ 6. Déduplication       eventId unique + prise atomique de la jambe bancaire
   ├─ 7. Confirmation        PROVIDER_CONFIRMED  ou  PROVIDER_FAILED
   ├─ 8. Contrôle du montant écart → AMOUNT_MISMATCH_DETECTED, BANK_PROCESSING_BLOCKED
   │                         le paiement fournisseur reste COMPLETED, la jambe
   │                         bancaire ne part pas, le remboursement passe REQUIRED
   ├─ 9. Appel SOAP          uniquement si montant et devise concordent
   ├─ 10. Rapprochement      RECONCILIATION_MATCHED  ou  RECONCILIATION_MISMATCH
   └─ 11. Clôture            CASE_CLOSED — synthèse du dossier, si plus rien n'est dû
   │
   └─→ 200 OK

[asynchrone, périodique]
   └─ Clôtures en attente → arbre de Merkle → racine publiée sur la chaîne
                          → une clôture engage récursivement tout l'historique

[exploitation]
   └─ POST /treasury/sweeps → SETTLEMENT_SWEPT sur les dossiers soldés
                            → fonds rapatriés de l'agrégateur vers la banque

GET /api/v1/transfers/{ref}/verification
   └─ Rejoue chaque fait · vérifie le chaînage · confronte la ligne au registre
     · contrôle l'inclusion de la clôture auprès du contrat
```

Quatre principes structurants :

- **La transaction est enregistrée avant tout appel externe.** Le SOAP ne part qu'après réception
  d'une confirmation Mobile Money authentifiée.
- **Rien n'est jamais corrigé, seulement complété.** Un fait nouveau s'ajoute au registre ; aucune
  preuve antérieure n'est modifiée ni remplacée. Un écart n'efface pas la confirmation qui l'a
  précédé — il la contredit, et les deux restent visibles.
- **Seule une clôture est ancrée.** Un état intermédiaire, ou un dossier dont la dette n'est pas
  éteinte, reste hors chaîne. Après résolution — remboursement compris — la clôture engage toute la
  chaîne de faits, écarts inclus. Un dossier litigieux finit donc ancré lui aussi : c'est
  précisément celui dont on contestera l'historique.
- **L'ancrage est asynchrone.** Une écriture on-chain prend de quelques secondes à plusieurs
  minutes ; l'inclure dans le cycle HTTP reproduirait le défaut que l'on évite déjà sur le SOAP. Le
  scellement de chaque fait, lui, est synchrone et instantané.

Le flux de virement classique (`POST /transfers`) suit le même modèle en une seule jambe :
`TRANSFER_INITIATED` → `TRANSFER_COMPLETED` ou `TRANSFER_FAILED` → `CASE_CLOSED`.

---

## Stack

| Besoin           | Choix                                                       |
| ---------------- | ----------------------------------------------------------- |
| API              | NestJS 11 (Express 5)                                       |
| Base de données  | PostgreSQL 16                                               |
| ORM              | TypeORM 0.3 (repository dédié, verrouillage optimiste)      |
| Client SOAP      | `soap` (node-soap) sur WSDL embarqué                        |
| Analyse XML      | `xml2js` avec gardes anti-XXE                               |
| Validation XSD   | `xmllint-wasm` — libxml2 en WebAssembly                     |
| Blockchain       | Chaîne EVM locale (Anvil / nœud Hardhat) + contrat Solidity |
| Client chaîne    | `ethers` v6                                                 |
| Documentation    | Swagger / OpenAPI 3                                         |
| Tests            | Jest + Supertest — **370 tests**                            |
| Conteneurisation | Docker multi-stage + Docker Compose                         |

`xmllint-wasm` a été retenu plutôt que `libxmljs` (compilation native) ou `xsd-schema-validator`
(dépendance à une JVM) : c'est le même moteur que l'outil `xmllint` de référence, sans rien à
compiler, identique du poste de développement à l'image Alpine.

---

## Démarrage

### Option A — Docker Compose

```bash
cp .env.example .env

# Génère le secret à transmettre à l'appelant et l'empreinte à placer dans API_KEYS
npm run auth:keygen -- local \
  transfers:read,transfers:write,refunds:write,reconciliation:write,ledger:read,treasury:write,anchors:read,anchors:write,simulator:write

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

# Reporter l'entrée générée dans API_KEYS et conserver le secret affiché
npm run auth:keygen -- local \
  transfers:read,transfers:write,refunds:write,reconciliation:write,ledger:read,treasury:write,anchors:read,anchors:write,simulator:write

# 1. Chaîne EVM locale
npm run chain:node

# 2. Compilation et déploiement du contrat
npm run contract:compile
npm run contract:deploy      # affiche l'adresse → BLOCKCHAIN_CONTRACT_ADDRESS dans .env

# 3. Migrations, puis passerelle
npm run migration:run
npm run start:dev
```

- API : http://localhost:3000/api/v1
- Swagger : http://localhost:3000/api/docs
- Santé : http://localhost:3000/api/v1/health

Pour travailler sans chaîne, `BLOCKCHAIN_ENABLED=false` : les faits restent consignés, scellés et
chaînés — une altération demeure détectable localement — mais aucune clôture n'est publiée, et le
verdict plafonne donc à `PARTIALLY_ANCHORED`.

### Authentification

Toutes les routes métier refusent par défaut les appels sans clé d'API. Seules la sonde de santé et
le webhook Mobile Money sont publics ; ce dernier vérifie sa propre signature HMAC.

Le générateur affiche une seule fois un secret sous la forme `<keyId>.<secret>` et une entrée hachée
à ajouter à `API_KEYS`. Les appels présentent ensuite :

```bash
Authorization: Bearer <keyId>.<secret>
```

Les droits sont indépendants : `transfers:read`, `transfers:write`, `refunds:write`,
`reconciliation:write`, `ledger:read`, `treasury:write`, `anchors:read`, `anchors:write` et
`simulator:write`.
`AUTH_ENABLED=false` est réservé au développement et bloque le démarrage en production.

---

## API

### Initier une transaction Mobile Money

```bash
curl -X POST http://localhost:3000/api/v1/mobile-money/transactions \
  -H 'Authorization: Bearer <keyId>.<secret>' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: cmd-2026-0042' \
  -d '{
    "operator":     "MPESA",
    "payerMsisdn":  "+243812345678",
    "creditorIban": "DE89370400440532013000",
    "creditorName": "ACME GmbH",
    "amount":       1250.75,
    "currency":     "EUR",
    "externalReference": "COMMANDE-2026-0042"
  }'
```

La réponse `201 Created` contient une `aggregatorReference` et reste `PENDING`. Pour simuler la
confirmation opérateur et exercer exactement le chemin webhook signé :

```bash
curl -X POST \
  http://localhost:3000/api/v1/simulator/mobile-money/payments/AGG-20260725-A1B2C3D4E5F6/confirm \
  -H 'Authorization: Bearer <keyId>.<secret>' \
  -H 'Content-Type: application/json' \
  -d '{}'
```

Le simulateur accepte un `amount`, une `currency` ou un statut `FAILED` pour tester les écarts et
rejets. Le MSISDN et les IBAN sont masqués dans les réponses et les journaux.

### Consulter le registre des faits

```bash
curl -H 'Authorization: Bearer <keyId>.<secret>' \
  http://localhost:3000/api/v1/transfers/TRF-20260725-C5WMM0G1/events
```

Chaque maillon porte son rang, son empreinte, celle du fait précédent et son état d'ancrage. Les
parties ne figurent que sur le fait d'ouverture, et toujours masquées sur la surface HTTP.

### Vérifier l'intégrité

```bash
curl -H 'Authorization: Bearer <keyId>.<secret>' \
  http://localhost:3000/api/v1/transfers/TRF-20260725-C5WMM0G1/verification
```

```json
{
  "transactionReference": "TRF-20260725-C5WMM0G1",
  "verdict": "VERIFIED",
  "closed": true,
  "finalProofAnchored": true,
  "transactionMatchesLedger": true,
  "declaredEventCount": 3,
  "eventCount": 3,
  "anchoredCount": 1,
  "head": "0xcdbc888192912d74a7759e3be4ed14e115da05c8cccb9994505dad7496715eac",
  "events": [
    {
      "sequence": 1,
      "eventType": "TRANSFER_INITIATED",
      "xsdValid": true,
      "fingerprintMatches": true,
      "chainIntact": true,
      "anchorVerified": null
    },
    { "sequence": 2, "eventType": "TRANSFER_COMPLETED", "…": "…" },
    { "sequence": 3, "eventType": "CASE_CLOSED", "…": "…", "anchorVerified": true }
  ],
  "findings": [
    "Les 3 evenements sont intacts et ordonnes. La cloture ancree engage tout l historique ; sommet de chaine : 0xcdbc…5eac.",
    "Dossier clos : le total declare fait foi, aucune troncature possible."
  ]
}
```

`anchoredCount: 1` sur trois faits n'est pas une lacune : seule la clôture est publiée, et son
empreinte couvre celle du fait précédent, qui couvre la précédente. Une inclusion engage tout.

Après un `UPDATE transactions SET creditor_iban = …` exécuté directement en base :

```json
{
  "verdict": "TAMPERED",
  "transactionMatchesLedger": false,
  "findings": [
    "ALTERATION DETECTEE : la ligne ne correspond plus a ce que l ouverture a consigne (IBAN du beneficiaire).",
    "ALTERATION DETECTEE dans le registre d evenements."
  ]
}
```

| Verdict              | Signification                                                |
| -------------------- | ------------------------------------------------------------ |
| `VERIFIED`           | Registre intact et clôture confirmée par le contrat          |
| `PARTIALLY_ANCHORED` | Dossier encore ouvert, ou clôture en attente du prochain lot |
| `TAMPERED`           | **Altération, rupture de chaîne ou troncature détectée**     |
| `EMPTY`              | Aucun fait consigné pour cette référence                     |
| `CHAIN_UNAVAILABLE`  | Contenu et ordre confirmés, nœud injoignable                 |

`EMPTY` n'est rendu que si l'absence est plausible. Si la ligne porte un état final alors que sa
chaîne a disparu, le verdict est `TAMPERED` : effacer le registre ne doit pas produire un rapport
rassurant.

### Rembourser

Un écart de montant place le dossier en `MANUAL_REVIEW` et le remboursement en `REQUIRED`. Le
remboursement porte sur ce qui a été **collecté**, pas sur ce qui avait été ordonné.

| Méthode | Route                            | Rôle                                               |
| ------- | -------------------------------- | -------------------------------------------------- |
| `POST`  | `/transfers/{ref}/refund`        | Déclenche ou reprend un remboursement — idempotent |
| `POST`  | `/transfers/{ref}/refund/reopen` | Rouvre un remboursement rejeté après correction    |
| `GET`   | `/transfers/{ref}/refund`        | État, tentatives, dernière erreur                  |

La clé d'idempotence fournisseur est générée une fois et renvoyée telle quelle à chaque tentative :
deux reprises ne peuvent pas produire deux remboursements. Un rejet métier (`retryable: false`) est
distingué d'un échec de transport (`retryable: true`) — seul le second est repris automatiquement.
C'est l'extinction de la dette qui autorise la clôture, donc l'ancrage.

### Autres points d'entrée

| Méthode | Route                                            | Rôle                                             |
| ------- | ------------------------------------------------ | ------------------------------------------------ |
| `POST`  | `/mobile-money/transactions`                     | Initie une collecte Mobile Money                 |
| `GET`   | `/mobile-money/transactions/{ref}`               | Cycle agrégateur / banque / rapprochement        |
| `POST`  | `/webhooks/mobile-money`                         | Callback agrégateur signé et idempotent          |
| `POST`  | `/simulator/mobile-money/payments/{ref}/confirm` | Confirmation, rejet ou écart simulé              |
| `POST`  | `/mobile-money/reconciliation/run`               | Reprise des rapprochements éligibles             |
| `POST`  | `/transfers`                                     | Virement classique, une seule jambe              |
| `GET`   | `/transfers`                                     | Liste paginée, filtres `status` et `currency`    |
| `GET`   | `/transfers/{ref}`                               | Statut d'un virement                             |
| `GET`   | `/transfers/{ref}/events`                        | Registre des faits                               |
| `GET`   | `/transfers/{ref}/verification`                  | Contrôle d'intégrité complet                     |
| `GET`   | `/transfers/{ref}/audit`                         | Piste d'audit technique (payloads XML masqués)   |
| `GET`   | `/anchors/batches`                               | Lots d'ancrage et leurs transactions blockchain  |
| `GET`   | `/anchors/batches/{id}`                          | Détail d'un lot                                  |
| `POST`  | `/anchors/batches`                               | Ancrage immédiat (exploitation / démonstration)  |
| `GET`   | `/anchors/statistics`                            | Répartition par état d'ancrage                   |
| `GET`   | `/ledger/balance`                                | Soldes comptables par compte                     |
| `GET`   | `/ledger/transfers/{ref}/entries`                | Écritures d'une transaction                      |
| `POST`  | `/treasury/sweeps`                               | Rapatriement des fonds — idempotent              |
| `GET`   | `/health`                                        | PostgreSQL, client SOAP, schémas XSD, blockchain |

---

## Le modèle de preuve

### Ce qui est scellé

Chaque transition métier produit un document `TransactionEvent` canonique validé contre
`transaction-event.xsd`. Il porte le statut des jambes, les montants attendu et observé, l'empreinte
du fait précédent et, sur l'ouverture, les parties du virement. La passerelle calcule :

```
empreinte = keccak256( sel(32 octets) ‖ documentXmlCanonique )
```

L'empreinte est calculée **avant** l'insertion : la ligne n'existe jamais dans un état non prouvé.
**Le document n'est pas conservé** — il est reconstruit depuis le registre au moment de la
vérification. Modifier un fait casse son empreinte ; retirer ou réordonner un fait casse le chaînage.

Dix-neuf types de faits sont consignés, dont `TRANSFER_INITIATED`, `PROVIDER_CONFIRMED`,
`AMOUNT_MISMATCH_DETECTED`, `BANK_PROCESSING_BLOCKED`, `RECONCILIATION_MISMATCH`,
`REFUND_REQUESTED`, `REFUND_COMPLETED` et `CASE_CLOSED`.

#### Un registre, pas un instantané

Une version antérieure scellait un instantané de la transaction une fois le rapprochement
`MATCHED`. Ce modèle avait deux défauts : il ne prouvait rien des dossiers en écart — ceux qu'on
contestera précisément — et il ne conservait aucune trace du chemin parcouru.

Le registre remplace cet instantané. La table `transaction_events` est **append-only, garantie par
la base** : un déclencheur PostgreSQL rejette tout `UPDATE` touchant autre chose que les colonnes
d'ancrage, et tout `DELETE`. Le déclencheur est réinstallé au démarrage, de sorte qu'un schéma
recréé par `synchronize` en développement ne perde pas la garantie silencieusement.

#### L'écriture métier et sa consignation sont indissociables

Un fait n'est pas un journal écrit après coup : il est produit **dans la même transaction SQL** que
le changement d'état qu'il atteste. Il n'existe donc aucun instant où une ligne aurait avancé sans
son témoin.

Cette propriété est moins évidente qu'elle n'en a l'air. Écrire les deux séparément — l'état, puis
le fait — laisse une fenêtre où un incident produit un dossier dont l'état n'est justifié par rien.
Or la vérification ne peut pas distinguer ce cas d'une suppression malveillante : elle rendrait un
verdict `TAMPERED` sur un système parfaitement honnête. **Un audit qui accuse à tort en cas de
panne perd ce qu'il prétend garantir.**

Deux points d'implémentation en découlent :

- **Point de sauvegarde par tentative.** PostgreSQL avorte toute la transaction sur une violation de
  contrainte. Or la gestion des collisions de rang repose précisément sur une violation rattrapée :
  sans `SAVEPOINT`, la première collision détruirait la transaction métier englobante.
- **La clôture lit par le même manager.** Elle scelle le nombre total de faits ; lue de l'extérieur
  de la transaction, elle ne verrait pas ceux qui viennent d'y être ajoutés et scellerait un total
  faux.

Les appels externes — SOAP, fournisseur de remboursement — restent **hors** de ces transactions :
aucun verrou n'est tenu pendant un appel réseau.

#### Trois propriétés indépendantes, et il faut les trois

| Propriété       | Ce qu'elle prouve                                    | Ce qu'elle laisserait passer seule      |
| --------------- | ---------------------------------------------------- | --------------------------------------- |
| **Contenu**     | Chaque document redonne son empreinte scellée        | Le retrait pur et simple d'un fait      |
| **Ordre**       | Chaque maillon pointe vers l'empreinte du précédent  | Une chaîne entièrement réécrite         |
| **Publication** | L'inclusion de la clôture mène à une racine on-chain | Rien — c'est le point d'ancrage externe |

#### La clôture ferme la troncature de queue

Le chaînage protège l'ordre et le contenu, mais laisse une ouverture : retirer les N derniers faits
produit une chaîne `1..M` parfaitement cohérente, indiscernable d'un dossier encore en cours.

L'événement `CASE_CLOSED` déclare le **nombre total de faits** et le **sommet de chaîne**. Une fois
ancré, il rend la troncature détectable : le compte publié ne correspondrait plus à ce que la base
contient. Il fournit accessoirement à un tiers une valeur unique de 32 octets qui engage tout le
dossier, sans qu'il ait à conserver la chaîne entière.

Une clôture est _attendue_ dès que l'état courant ou un fait encore présent prouve que le dossier a
atteint une issue. Croiser les deux sources est délibéré : une troncature peut retirer le fait
terminal, tandis qu'une altération de la ligne courante peut tenter de masquer qu'elle était finale.

#### La confrontation de la ligne au registre

Vérifier la seule chaîne prouverait que les faits sont intacts, sans rien dire de la table
`transactions`. Un IBAN bénéficiaire modifié après coup passerait au travers.

Le fait d'ouverture consigne donc les parties du virement — donneur d'ordre, bénéficiaire, libellé,
montant, devise — **une seule fois** : elles ne changent pas, et les répéter à chaque fait
alourdirait la chaîne sans rien prouver de plus. La vérification confronte la ligne courante à cet
enregistrement et nomme le champ divergent (`transactionMatchesLedger`).

C'est ce contrôle qui rend le remplacement de l'instantané équivalent, et non une simple
réorganisation.

#### Pourquoi un sel

Un IBAN a une entropie faible : pays, banque et guichet suivent des formats publics, et un montant
se devine souvent. Publier `keccak256(document)` exposerait la preuve à une attaque par force brute
sur les préimages — il suffirait de tester des documents plausibles jusqu'à retrouver le condensat.

Chaque fait reçoit donc un sel aléatoire de 32 octets, conservé en base et **jamais publié**.
Conséquence secondaire utile : deux faits identiques n'exposent pas la même empreinte.

#### Pourquoi la canonicité est critique

L'empreinte porte sur les octets exacts du document. Le sérialiseur est donc déterministe par
construction plutôt que canonicalisé après coup (C14N) : ordre imposé par le XSD, indentation fixe,
fins de ligne LF, montants toujours à 2 décimales (`1250.7` → `1250.70`), dates ISO 8601 UTC,
éléments optionnels vides omis. L'attribut `version` du document permettra de rejouer la
vérification d'archives anciennes si le format évolue.

Corollaire concret pour la maintenance : les blocs ajoutés au XSD (`closure`, puis `parties`) l'ont
été **en fin de séquence**, afin que les documents antérieurs se sérialisent à l'identique. Déplacer
un élément existant invaliderait toutes les empreintes déjà publiées.

### Ce qui est ancré

Ancrer chaque fait intermédiaire ferait croître le coût et publierait des états encore susceptibles
d'évoluer. Seuls les événements `CASE_CLOSED` sont regroupés en lots, puis seule la **racine de
Merkle** du lot est publiée : un mot de 32 octets, que le lot contienne 1 ou 1000 dossiers.

```
                     racine  ← publiée sur la chaîne
                    /      \
               h(01)        h(23)
              /    \        /    \
          feuille0  f1     f2     f3     feuille = keccak256(empreinte)
```

Chaque clôture conserve son **chemin de hashs frères** (preuve d'inclusion), de taille
logarithmique. Comme son empreinte couvre celle du fait précédent, qui couvre elle-même la
précédente, une seule inclusion engage récursivement tout le dossier.

Trois conventions rendent les preuves vérifiables indifféremment hors chaîne et par le contrat :

- **Paires triées** — `hash(a,b) = keccak256(min ‖ max)`, donc pas besoin de mémoriser les positions
  gauche/droite. Conséquence assumée : l'ordre au sein d'une paire est perdu. L'arbre prouve
  l'appartenance d'une clôture à un lot, pas son rang — l'ordre des faits, lui, est établi par le
  chaînage.
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

Comparer les empreintes recalculées à celles stockées dans la même base ne suffit pas : un attaquant
disposant d'un accès total pourrait réécrire toute la chaîne de faits. La clôture publiée apporte le
point de référence que l'opérateur ne contrôle plus.

Voici la défense en profondeur, telle que réellement exercée sur cette implémentation :

| Ce que fait l'attaquant (accès total en écriture à la base) | Contrôle qui cède                    | Verdict    |
| ----------------------------------------------------------- | ------------------------------------ | ---------- |
| Modifie l'IBAN du bénéficiaire dans `transactions`          | `transactionMatchesLedger` → `false` | `TAMPERED` |
| …et tente d'aligner le fait consigné sur la falsification   | le déclencheur rejette l'`UPDATE`    | **refusé** |
| Retire ou réordonne un fait                                 | empreinte, chaînage ou total déclaré | `TAMPERED` |
| Réécrit tous les faits et rescelle la clôture               | inclusion de la clôture invalide     | `TAMPERED` |

À la dernière ligne, tous les contrôles internes passent — et la chaîne tranche seule. La deuxième
est la plus intéressante : l'attaque naturelle contre une confrontation ligne/registre est de
falsifier les deux côtés, et c'est la base elle-même qui la refuse.

---

## Sécurité et confidentialité

### Où vivent les IBAN complets

| Destination                      | IBAN complet ?                                          |
| -------------------------------- | ------------------------------------------------------- |
| Table `transactions`             | **Oui** — nécessaire à l'exécution du virement          |
| `transaction_events` (ouverture) | **Oui** — référence de la confrontation, jamais publiée |
| Document scellé (transitoire)    | **Oui** — c'est l'objet de la preuve, jamais publié     |
| Réponses HTTP                    | Non — masqué `FR76****0189`                             |
| Logs applicatifs                 | Non — masqué                                            |
| Table `audit_logs`               | Non — masqué puis tronqué                               |
| Blockchain                       | Non — seule une racine de Merkle y figure               |

Le masquage opère à trois niveaux (`src/common/utils/masking.util.ts`) : IBAN (`FR76****0189`),
secrets (`[REDACTED]` intégral), et **texte libre / XML par détection de motif** — un IBAN glissé
dans un commentaire ou une balise non prévue est masqué quand même.

La route `/events` expose `debtorIbanMasked` et `creditorIbanMasked`, jamais les valeurs brutes ; un
test e2e inspecte le corps entier de la réponse pour s'en assurer. La règle est vérifiée en exécution
réelle : sur 445 lignes de log produites par un virement complet, **zéro** occurrence d'IBAN en
clair.

### Durcissement des parseurs

Un parseur XML est une surface d'attaque classique. Avant tout parsing, la couche SOAP rejette
`<!DOCTYPE`, `<!ENTITY` (XXE et _billion laughs_), `<?xml-stylesheet`, et toute réponse au-delà de
`SOAP_MAX_RESPONSE_BYTES`. Le rejet est explicite plutôt que délégué au comportement par défaut
d'une dépendance tierce.

Côté génération, l'échappement XML joue un double rôle : conformité du document, et neutralisation
d'une injection. Un nom de bénéficiaire contenant `</creditorName>` ne peut pas restructurer le
document — donc pas davantage détourner l'empreinte scellée.

### Signature du webhook

Le HMAC couvre une canonicalisation **préfixée en longueur** (`${len}:${valeur}` joints par `|`)
plutôt qu'une simple concaténation : sans cela, deux jeux de champs distincts pourraient produire la
même chaîne à signer. Le même défaut a été trouvé et corrigé dans le format des clés d'API.

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

**`transactions`** — vue métier courante : référence et clé d'idempotence uniques, IBAN, montant
`numeric(18,2)`, métadonnées SOAP et agrégateur, et **cinq statuts orthogonaux** :
`provider_status`, `bank_status`, `reconciliation_status`, `refund_status`, `case_status`.
Verrouillage optimiste via `@VersionColumn`.

Les modéliser séparément est ce qui permet de représenter l'état réel d'un écart de montant : le
paiement fournisseur reste `COMPLETED` — l'argent a bien été collecté — pendant que la jambe bancaire
est `BLOCKED`, le rapprochement `AMOUNT_MISMATCH`, le dossier `MANUAL_REVIEW` et le remboursement
`REQUIRED`. Un statut unique aurait forcé à écraser un fait vrai par un autre.

#### La machine à états

Cette indépendance a un revers : l'espace produit compte plusieurs milliers de combinaisons, dont
l'immense majorité ne correspond à rien. Deux mécanismes l'encadrent, et il faut les deux.

**Les tables de transitions** (`src/transactions/state/`) fixent, dimension par dimension, ce qui
peut suivre quoi. Les valeurs terminales ne bougent plus : un encaissement constaté ne se dément
pas, une instruction bancaire bloquée ne se reprend pas.

**Les invariants** ferment ce qu'une table seule laisserait passer, faute de voir plus d'une
dimension à la fois :

| Invariant                             | Ce qu'il interdit                                       |
| ------------------------------------- | ------------------------------------------------------- |
| `bank-requires-provider-confirmation` | Instruire la banque sans encaissement confirmé          |
| `refund-requires-collection`          | Rembourser ce qui n'a pas été encaissé                  |
| `resolved-case-requires-extinct-debt` | Résoudre un dossier dette pendante                      |
| `matched-requires-both-legs-done`     | Un rapprochement conforme dont une jambe n'a pas abouti |
| `blocked-bank-implies-declared-gap`   | Un blocage bancaire sans écart nommé                    |

Le contrôle s'exécute **dans** la transaction : une transition refusée annule l'écriture au lieu de
la constater. C'est déterminant ici — le registre étant append-only, un état impossible consigné est
scellé puis publié, et ne se corrige plus. La machine est le dernier endroit où l'erreur peut encore
être arrêtée.

**Les cinq invariants sont aussi des contraintes `CHECK`**, déclarées sur l'entité _et_ en migration.
La machine arrête l'erreur au plus près de sa cause et la nomme ; la base ferme ce qui la contourne —
script d'exploitation, correctif manuel, futur service. Vérifié en SQL direct.

La table de transitions, elle, reste applicative : une contrainte `CHECK` ne voit que la ligne
d'arrivée, jamais l'état d'où elle vient. La répliquer demanderait un déclencheur comparant `OLD` et
`NEW`, comme le garde append-only.

**`transaction_events`** — registre append-only : rang unique par transaction, type, références
interne / fournisseur / bancaire, les cinq statuts, montants attendu et observé, corrélation,
empreinte salée, empreinte du fait précédent, parties de l'ouverture, preuve de clôture
(`closure_event_count`, `closure_chain_head`) et, sur la seule clôture, preuve Merkle du dossier.
Protégée par déclencheur.

**`refunds`** — statut, montant, motif, clé d'idempotence fournisseur, référence du remboursement,
tentatives, dernière erreur, `retryable`, horodatages et corrélation.

**`audit_logs`** — sens de l'échange (`DOCUMENT_VALIDATED`, `OUTBOUND_REQUEST`, `INBOUND_RESPONSE`,
`INBOUND_FAULT`, `COMMUNICATION_ERROR`), payload masqué et tronqué, durée, code de faute,
corrélation. Écriture _best-effort_ : un échec d'audit ne fait jamais échouer la transaction métier.

C'est la différence de nature avec `transaction_events` : l'audit technique documente un échange, le
registre établit un fait. Le premier peut être perdu sans conséquence, le second non — un événement
manquant creuserait un trou dans la chaîne, aussi son échec est-il propagé.

**`anchor_batches`** — statut, racine de Merkle, nombre de feuilles, `chain_id`, adresse du contrat,
`tx_hash`, numéro de bloc, gaz consommé, tentatives, dernière erreur.

**`journal_entries` / `journal_lines`** — comptabilité en partie double. Chaque écriture référence
le fait dont elle découle (`event_id`, **unique**), et porte des lignes `(compte, sens, montant)`.
Append-only, et équilibre imposé par déclencheur.

**`mobile_money_webhook_events`** — déduplication par `eventId`, avec reprise des prises périmées.

> **Résidu assumé.** La table `transactions` conserve les colonnes de l'ancien scellement
> (`fingerprint`, `fingerprint_salt`, `sealed_at`, `merkle_proof`…). Elles ne sont plus alimentées,
> mais elles portent des preuves déjà publiées sur la chaîne : les supprimer irait contre l'objet
> même de ce projet.

## Comptabilité en partie double

Le modèle à cinq statuts dit **qu'une** dette existe ; il ne dit pas **combien**. Sur un écart de
montant, `refund_status = REQUIRED` ne portait aucune somme : le montant dû n'était déductible que
par recoupement, et un remboursement partiel laissait un reliquat parfaitement invisible.

Le ledger rend cette dette chiffrée, opposable et **vérifiable** : la somme des débits égale celle
des crédits, ou la base refuse l'écriture.

### Le plan de comptes

| Compte             | Nature  | Ce qu'il représente                                   |
| ------------------ | ------- | ----------------------------------------------------- |
| `PROVIDER_FLOAT`   | actif   | Fonds encaissés et détenus chez l'agrégateur          |
| `SETTLEMENT`       | actif   | Compte bancaire de la passerelle                      |
| `CREDITOR_PAYABLE` | passif  | Dû au bénéficiaire tant que la banque n'a pas exécuté |
| `PAYER_PAYABLE`    | passif  | Dû au payeur — dette née d'un écart ou d'un échec     |
| `FEE_REVENUE`      | produit | Commission retenue sur un service effectivement rendu |

**Le virement classique n'y figure pas.** Il instruit la banque sans jamais détenir de fonds : lui
inventer une existence comptable serait faux. Un test le verrouille.

### Les écritures

```
PROVIDER_CONFIRMED 1250.75          AMOUNT_MISMATCH_DETECTED (1200 encaissés ≠ 1250.75 commandés)
  D  provider_float    1250.75        D  provider_float    1200.00
  C  creditor_payable  1231.99        C  payer_payable     1200.00
  C  fee_revenue         18.76      → aucune commission : aucun service rendu

SETTLEMENT_SWEPT                    BANK_PROCESSING_FAILED
  D  settlement        1250.75        D  creditor_payable  1231.99
  C  provider_float    1250.75        D  fee_revenue         18.76
                                      C  payer_payable     1250.75
BANK_PROCESSING_COMPLETED           → la commission est contre-passée : facturer un
  D  creditor_payable  1231.99        échec serait indéfendable
  C  settlement        1231.99
                                    REFUND_COMPLETED
                                      D  payer_payable     1200.00
                                      C  provider_float    1200.00
```

Les faits absents de cette table n'ont **aucun** effet comptable : ils décrivent un changement
d'état, pas un mouvement de fonds. Un rapprochement conforme constate que les deux jambes
concordent — il ne déplace rien.

### La commission

Le montant est **figé sur la transaction à la confirmation**, jamais recalculé. Le taux
(`MOBILE_MONEY_FEE_RATE`, 1,5 % par défaut) est une donnée de configuration : le recalculer à la
lecture ferait varier rétroactivement des écritures déjà passées.

### Le rapatriement des fonds

L'agrégateur ne notifie pas ses reversements — il les exécute selon son propre calendrier. Le
déduire d'un autre fait reviendrait à inventer une observation. Le rapatriement est donc une
**opération d'exploitation explicite** (`POST /treasury/sweeps`), consignée au registre comme
n'importe quel autre fait : scellée, chaînée, ancrable.

Ne sont rapatriés que les dossiers **soldés** — rapprochement conforme, aucun remboursement dû. Les
fonds d'un litige restent chez l'agrégateur, là où le remboursement sera exécuté.

Son idempotence se lit dans le registre lui-même : une transaction déjà porteuse d'un
`SETTLEMENT_SWEPT` est écartée. Aucun état supplémentaire n'a besoin d'être maintenu. Deux
balayages concurrents sont départagés par un verrou et une relecture, ce qui les réduit à un seul
fait comptable.

### Deux garanties imposées par la base

**Équilibre.** Un déclencheur `CONSTRAINT ... DEFERRABLE` vérifie au commit que débits et crédits
s'égalent. Il est posé sur les deux tables : sur les seules écritures, une ligne ajoutée après coup
ne toucherait pas l'en-tête et ne déclencherait donc rien — l'équilibre ne serait garanti qu'à la
pose initiale, c'est-à-dire pas garanti.

**Immuabilité.** Écritures et lignes sont append-only. Une erreur comptable se corrige par
contre-passation, jamais par réécriture : c'est la règle qui rend un journal opposable.

Le texte SQL de ces garanties est défini **en un seul endroit**, partagé par la migration et
l'installateur de démarrage. Ce projet a déjà payé le prix d'une duplication de ce type.

### Consulter

```bash
curl -H 'Authorization: Bearer <keyId>.<secret>' \
  'http://localhost:3000/api/v1/ledger/balance?reference=TRF-20260725-C5WMM0G1'
```

| Méthode | Route                             | Rôle                                              |
| ------- | --------------------------------- | ------------------------------------------------- |
| `GET`   | `/ledger/balance`                 | Soldes par compte ; `difference` doit valoir zéro |
| `GET`   | `/ledger/transfers/{ref}/entries` | Écritures d'une transaction, avec leurs lignes    |
| `POST`  | `/treasury/sweeps`                | Rapatriement — idempotent                         |

Une balance **globale** portant sur plusieurs devises est refusée (`400`) plutôt que sommée :
additionner des montants incompatibles produirait un total qui ne veut rien dire. Le paramètre
`currency` lève l'ambiguïté.

---

### Contrats XSD

| Schéma                  | Rôle                                                |
| ----------------------- | --------------------------------------------------- |
| `transfer-request.xsd`  | Demande validée avant l'appel SOAP                  |
| `transaction-event.xsd` | Fait canonique validé avant scellement et insertion |
| `transfer-response.xsd` | Contrat de sortie de l'API — documentaire           |

La clé de contrôle MOD 97-10 n'étant pas exprimable en XSD 1.0, elle reste vérifiée par
`IsIbanConstraint` : le XSD ne valide que la structure.

### Migrations

Onze migrations, rejouables depuis une base vide, `schema:log` propre à l'arrivée :

```
InitialSchema · AddBlockchainAudit · AddMobileMoneyFlow · SplitPaymentStatuses
AddTransactionEvents · AddRefunds · RefundReopenAndIntegrity · AddClosureProof
LedgerReplacesSnapshot · AddStateInvariants · AddDoubleEntryLedger
```

---

## Tests

```bash
npm test          # 237 tests unitaires
npm run test:e2e  # 133 tests d'intégration (PostgreSQL requis, exécution sérielle)
npm run test:cov  # couverture
```

Les tests e2e utilisent `banking_soap_test`, bouchonnent le client SOAP, et remplacent la chaîne par
un registre en mémoire qui reproduit fidèlement le contrat (refus de réécriture, vérification
d'inclusion par recalcul). Ils sont donc **déterministes et hors ligne**, y compris pour les
scénarios de faute, de timeout et de falsification.

Les suites partagent une base et se tronquent mutuellement si elles s'exécutent en parallèle :
`test:e2e` passe `--runInBand`, et lancer `jest` directement sans cette option produit des échecs
qui n'ont rien à voir avec le code.

Couverture notable :

- **Merkle** — tailles 1 à 1024 dont impaires, preuve tronquée / allongée / altérée, feuille
  étrangère, racine falsifiée, déterminisme, propriété des paires triées ;
- **Registre** — unicité des sels, chaînage, collision de rang concurrente, rangs continus,
  protection append-only imposée par la base ;
- **Machine à états** — chemins réels du flux acceptés, retours en arrière et états impossibles
  refusés, diagnostic complet plutôt que première violation ;
- **Ledger** — équilibre sur chaque flux, écriture déséquilibrée refusée en SQL direct, dette
  chiffrée puis éteinte au centime, commission acquise puis contre-passée, rapatriement idempotent,
  virement classique sans aucune écriture ;
- **Atomicité** — la consignation est mise en échec délibérément, et l'écriture métier doit avoir
  disparu. Éprouvé en rétablissant l'écriture dédoublée d'origine : le test échoue alors, ce qui
  établit qu'il porte bien sur la propriété et non sur son apparence ;
- **Canonicité** — indépendance vis-à-vis de l'ordre de construction de l'objet, injection XML ;
- **Intégrité** — 6 champs falsifiés indépendamment, troncature de queue, rupture de chaîne,
  clôture absente, attaque à deux volets (ligne + fait consigné) ;
- **Remboursement** — reprise idempotente, rejet non rejouable, réouverture après correction,
  clôture conditionnée à l'extinction de la dette ;
- **Résilience** — chaîne injoignable distinguée d'une altération, remise en file après échec.

### Défauts réels trouvés pendant le développement

1. `<soap:Fault/>` vide non reconnu comme faute (xml2js le rend en chaîne vide) ;
2. après résolution d'une course d'idempotence, la transaction gagnante était retraitée — soit un
   **second appel SOAP pour un seul virement** ;
3. entités XML non décodées (`---&gt;`) dans le message d'erreur rendu au client ;
4. **collision de nonce** sur deux ancrages rapprochés : `ethers` met en cache
   `eth_getTransactionCount`, d'où un rejet « nonce too low ». Corrigé par `NonceManager` ;
5. le test « l'ordre des feuilles change la racine » était **faux** — avec des paires triées,
   échanger deux frères ne change rien. La propriété a été documentée plutôt que contournée ;
6. le contrôle du montant s'exécutait **après** la prise de la jambe bancaire : un écart pouvait
   partir en banque. Le garde a été déplacé à l'intérieur de la prise atomique ;
7. canonicalisation du HMAC sans préfixe de longueur — deux jeux de champs distincts pouvaient
   produire la même chaîne à signer ;
8. un webhook en erreur restait bloqué en `PROCESSING` ; ajout d'une reprise des prises périmées ;
9. les IBAN consignés par le registre transitaient **en clair** sur `GET /events`, la vue publique
   n'omettant que le sel. Masqués, et couverts par un test qui inspecte le corps entier ;
10. **écriture dédoublée** sur 17 sites : l'état métier était commité avant que le fait le soit. Un
    incident entre les deux laissait un dossier que la vérification déclarait `TAMPERED` à tort. Le
    cas le plus grave était la confirmation Mobile Money : la jambe bancaire restait prise sans fait
    correspondant, et le webhook ne pouvait plus jamais être rejoué — paiement bloqué définitivement.

---

## Validation en conditions réelles

Exercé contre le vrai service DataAccess, une chaîne Anvil/Hardhat locale et un bouchon SOAP :

| Scénario                                        | Résultat observé                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Virement nominal, service public réel           | `201 COMPLETED` · _"one thousand two hundred and fifty dollars and seventy five cents"_ · 1865 ms |
| Rejeu avec la même `Idempotency-Key`            | Référence identique, aucun second appel SOAP                                                      |
| Timeout SOAP (`SOAP_TIMEOUT_MS=100`)            | `504 SOAP_TIMEOUT` · 3 tentatives · `FAILED`                                                      |
| Faute SOAP 1.1 et 1.2 (bouchon HTTP 500)        | `502 SOAP_FAULT` · aucune reprise · faute persistée                                               |
| Arbre de Merkle vs `verifyInclusion` du contrat | Concordance sur 1, 2, 3, 5, 8 et 17 feuilles ; intrus rejeté                                      |
| Réécriture d'un lot déjà ancré                  | Rejetée — `BatchAlreadyAnchored`                                                                  |
| Ancrage par un compte non autorisé              | Rejeté — `NotAuthorized`                                                                          |
| Ancrage de 3 clôtures                           | 1 transaction chaîne, bloc 10, **121 159 gaz**                                                    |
| Virement abouti, registre complet               | 3 faits chaînés, 1 clôture ancrée, `VERIFIED`                                                     |
| IBAN bénéficiaire falsifié en base              | `TAMPERED`, champ divergent nommé dans le rapport                                                 |
| `UPDATE` sur un fait consigné                   | Rejeté par le déclencheur — `append-only`                                                         |
| État impossible écrit en SQL direct             | Rejeté par les contraintes `CHECK` (3 cas éprouvés)                                               |
| Écriture comptable déséquilibrée en SQL direct  | Rejetée au commit par le déclencheur d'équilibre                                                  |
| Écart de 1200 sur 1250.75 commandés             | `PAYER_PAYABLE = 1200.00` — la dette porte un montant, non un drapeau                             |
| Consignation en échec pendant une écriture      | Écriture métier annulée ; aucun dossier orphelin, rejeu possible                                  |
| Fuite d'IBAN (logs + audit + API)               | Aucune                                                                                            |

---

## Arborescence

```
├── contracts/AuditAnchor.sol       # Registre d'ancrage (Solidity)
├── scripts/                        # Compilation (solc) et déploiement (ethers)
├── src/
│   ├── transactions/               # Virement classique — orchestration
│   │   └── state/                  #   machine à états : transitions + invariants
│   ├── mobile-money/               # Collecte, webhook signé, rapprochement
│   ├── accounting/                 # Ledger en partie double
│   │   ├── posting-rules.ts        #   conséquence comptable de chaque fait
│   │   ├── ledger-posting.service.ts
│   │   └── ledger-guards.ts        #   équilibre + immuabilité, SQL partagé
│   ├── treasury/                   # Rapatriement des fonds vers la banque
│   ├── refunds/                    # Remboursement idempotent avec reprise
│   │   ├── provider-refund.port.ts #   port fournisseur (adaptateur simulé)
│   │   └── refunds.service.ts
│   ├── events/                     # Registre append-only des faits
│   │   ├── transaction-events.service.ts     #   consignation, chaînage, clôture
│   │   ├── transaction-event-xml.builder.ts  #   sérialisation canonique
│   │   ├── event-chain-verification.service.ts
│   │   └── append-only-guard.installer.ts    #   déclencheur d'immuabilité
│   ├── soap/                       # Couche anti-corruption SOAP
│   │   ├── soap-client.service.ts  #   transport, timeout, reprises
│   │   ├── soap-response.mapper.ts #   analyse XML, normalisation des fautes
│   │   └── wsdl/                   #   WSDL embarqué (aucun appel réseau au boot)
│   ├── xml/                        # Sérialisation canonique + validation XSD
│   ├── blockchain/                 # Ancrage Merkle des seules clôtures finales
│   │   ├── fingerprint.util.ts     #   sel + keccak256 + dérivation de feuille
│   │   ├── merkle.util.ts          #   arbre et preuves, compatibles OpenZeppelin
│   │   ├── anchor.service.ts       #   lots, planification, reprises
│   │   └── evm-anchor.client.ts    #   ethers ↔ contrat
│   ├── auth/                       # Clés d'API hachées, scopes, refus par défaut
│   ├── audit/ · common/ · config/ · database/ · health/
├── schemas/                        # transfer-request · transaction-event · transfer-response
├── samples/                        # Enveloppes SOAP réelles + payloads hostiles
├── test/                           # transfers · mobile-money · event-ledger · refunds
│                                   # · integrity · auth
└── docker-compose.yml · Dockerfile
```

---

## Limites assumées

Ce dépôt est une démonstration d'intégration, pas un service de paiement.

- **Authentification par secret partagé.** Les clés sont hachées et portées par scope, mais une mise
  en production exigerait OAuth2/mTLS, une rotation et une limitation de débit.
- **Aucun débit réel.** Le service SOAP convertit un montant en lettres ; il ne contacte aucun
  système de règlement, et l'adaptateur de remboursement est un simulateur.
- **Clé privée en variable d'environnement.** Acceptable sur une chaîne locale jetable dont le
  compte #0 est public. En production, la signature relèverait d'un HSM ou d'un KMS.
- **Chaîne locale.** Un registre réellement inviolable suppose une chaîne publique ou un consortium
  dont l'opérateur ne contrôle pas les validateurs. L'architecture est prête — `EvmAnchorClient`
  isole entièrement ethers — mais un testnet public introduirait une dépendance à un faucet et à un
  fournisseur RPC.
- **Un dossier jamais clos n'est jamais ancré.** C'est cohérent — on ne publie pas un état qui peut
  encore changer — mais cela signifie qu'un litige laissé ouvert indéfiniment reste sans preuve
  externe. Une politique d'exploitation devrait surveiller l'âge des dossiers ouverts.
- **Le déclencheur append-only protège de l'application, pas du DBA.** Un superutilisateur peut le
  désactiver. C'est précisément pour cela que l'ancrage existe : la garantie finale est hors base.
- **Traitement synchrone du virement.** Le modèle cible serait une file de messages avec reprise
  durable plutôt qu'un appel bloquant dans le cycle HTTP.
- **IBAN stockés en clair.** En production, chiffrement au repos ou coffre à jetons.
- **Pas de purge.** Le registre croît indéfiniment et, par nature, ne peut pas être élagué sans
  rompre le chaînage. Une politique de rétention supposerait d'archiver des segments clos avec leur
  preuve de synthèse.
- **Pas de vérification en masse.** Le contrôle est unitaire ; un audit de bout en bout supposerait
  une revérification par lot.
- **Pas de contre-passation exposée.** Le journal étant append-only, corriger une erreur comptable
  suppose une écriture inverse ; aucun point d'entrée ne la propose encore.
- **Le compte de règlement peut être négatif** entre le paiement du bénéficiaire et le rapatriement.
  C'est comptablement exact — un découvert — et non une anomalie, mais une exploitation réelle
  voudrait surveiller sa profondeur.
- **Aucune clôture de période.** Les soldes sont cumulatifs depuis l'origine ; il n'existe ni
  exercice, ni report à nouveau, ni états financiers.
