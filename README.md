# banking-soap-integration-demo

API REST d'initiation de virement bancaire adossée à un **service SOAP public**.

Le projet illustre un cas d'intégration récurrent en banque : une façade REST/JSON moderne qui
doit dialoguer avec un back-office SOAP/XML, sans jamais exposer de données sensibles dans ses
journaux ni dans sa piste d'audit.

Le service externe utilisé est [DataAccess Number Conversion](https://www.dataaccess.com/webservicesserver/NumberConversion.wso?WSDL),
dont l'opération `NumberToDollars` convertit le montant du virement **en toutes lettres** — l'équivalent
du libellé littéral qu'on retrouve sur un chèque ou un ordre de paiement.

---

## Chaîne de traitement

```
POST /api/v1/transfers  (JSON)
   │
   ├─ 1. Validation          IBAN (ISO 13616 + clé MOD 97-10), montant, devise, libellé SEPA
   ├─ 2. Règles métier       devise autorisée, plafond, comptes distincts
   ├─ 3. Idempotence         en-tête Idempotency-Key → rejeu sans nouvel appel externe
   ├─ 4. Référence unique    TRF-YYYYMMDD-XXXXXXXX (CSPRNG, Crockford base32)
   ├─ 5. Persistance         PostgreSQL, statut PENDING  ← AVANT tout appel externe
   ├─ 6. Appel SOAP          NumberToDollars, WSDL local, timeout + reprises
   ├─ 7. Analyse XML         xml2js durci → détection <soap:Fault> 1.1 / 1.2
   ├─ 8. Transformation      XML → JSON métier
   ├─ 9. Statut terminal     COMPLETED ou FAILED
   └─ 10. Audit              échanges consignés, payloads XML masqués
   │
   └─→ 201 Created  ·  GET /api/v1/transfers/{reference} pour consulter le statut
```

Point de conception structurant : **la transaction est enregistrée avant l'appel externe**. Si le
service SOAP échoue, l'API répond 502/504 mais renvoie la `reference` dans le corps d'erreur —
la demande reste consultable avec le statut `FAILED` et le détail de la faute.

---

## Stack

| Besoin | Choix |
| --- | --- |
| API | NestJS 11 (Express 5) |
| Base de données | PostgreSQL 16 |
| ORM | TypeORM 0.3 (repository dédié, verrouillage optimiste) |
| Client SOAP | `soap` (node-soap) sur WSDL embarqué |
| Parsing XML | `xml2js` avec gardes anti-XXE |
| Documentation | Swagger / OpenAPI 3 |
| Tests | Jest + Supertest — 142 tests |
| Conteneurisation | Docker multi-stage + Docker Compose |

TypeORM a été retenu plutôt que Prisma : l'arborescence demandée prévoit un
`transactions.repository.ts`, et le pattern *repository* de TypeORM s'y prête directement.

---

## Démarrage

### Option A — Docker Compose (recommandé)

```bash
cp .env.example .env
docker compose up --build
```

L'API attend que PostgreSQL soit réellement prêt (`healthcheck` + `depends_on: service_healthy`).

- API : http://localhost:3000/api/v1
- Swagger : http://localhost:3000/api/docs
- Santé : http://localhost:3000/api/v1/health

### Option B — Node en local

Nécessite un PostgreSQL joignable.

```bash
# Préparer la base
createdb banking_soap
psql -d banking_soap -c 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp";'

cp .env.example .env      # ajuster DB_USERNAME / DB_PASSWORD
npm install
npm run start:dev
```

`DB_SYNCHRONIZE=true` crée le schéma au démarrage — pratique en développement. En production,
laisser à `false` et utiliser les migrations (voir plus bas).

---

## Configuration

Toutes les variables sont documentées dans [`.env.example`](.env.example). Elles sont **validées au
démarrage** (`src/config/env.validation.ts`) : le processus refuse de démarrer sur une
configuration incohérente plutôt que d'échouer en pleine transaction.

Les plus structurantes :

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `SOAP_WSDL_SOURCE` | `local` | `local` = WSDL embarqué, aucun appel réseau au boot ; `remote` = téléchargé |
| `SOAP_ENDPOINT` | DataAccess | Adresse effective, surchargeable pour viser un bouchon en recette |
| `SOAP_TIMEOUT_MS` | `8000` | Délai par tentative |
| `SOAP_MAX_RETRIES` | `2` | Reprises sur **erreur de communication uniquement** |
| `SOAP_MAX_RESPONSE_BYTES` | `1048576` | Taille XML maximale acceptée par le parseur |
| `ALLOWED_CURRENCIES` | `EUR,USD,…` | Liste blanche ISO 4217 |
| `TRANSFER_MAX_AMOUNT` | `999999999.99` | Plafond par virement |
| `AUDIT_PERSIST_PAYLOADS` | `true` | `false` = aucun payload XML conservé (mode strict) |

---

## API

### `POST /api/v1/transfers` — initier un virement

En-têtes optionnels : `Idempotency-Key`, `X-Correlation-Id`.

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

`201 Created` — réponse réelle du service public :

```json
{
  "reference": "TRF-20260725-02AC53WQ",
  "status": "COMPLETED",
  "debtorIbanMasked": "FR76****0189",
  "debtorName": "Societe Kongo SARL",
  "creditorIbanMasked": "DE89****3000",
  "creditorName": "ACME GmbH",
  "amount": 1250.75,
  "currency": "EUR",
  "endToEndLabel": "Facture 2026-0042",
  "amountInWords": "one thousand two hundred and fifty dollars and seventy five cents",
  "soap": { "operation": "NumberToDollars", "durationMs": 1865, "attempts": 1 },
  "correlationId": "6f8724f3-104b-4423-8e55-affd30d1b812",
  "processedAt": "2026-07-25T10:30:31.748Z",
  "createdAt": "2026-07-25T10:30:29.839Z",
  "updatedAt": "2026-07-25T10:30:31.749Z"
}
```

Les IBAN sont volontairement **masqués** dans toute réponse HTTP : les champs s'appellent
`debtorIbanMasked` / `creditorIbanMasked` pour que le contrat soit explicite. La valeur complète
n'existe qu'en base, où elle est nécessaire à l'exécution du virement.

### `GET /api/v1/transfers/{reference}` — consulter le statut

### `GET /api/v1/transfers` — lister

Filtres `status`, `currency` ; pagination `page`, `limit` (max 100).

```bash
curl 'http://localhost:3000/api/v1/transfers?status=FAILED&limit=10'
```

### `GET /api/v1/transfers/{reference}/audit` — piste d'audit

Retourne les échanges SOAP consignés, avec payloads XML masqués et tronqués.

### `GET /api/v1/health` — supervision

`200` si PostgreSQL répond et que le client SOAP est initialisable, `503` sinon. La sonde
n'appelle **aucune** opération métier du fournisseur.

---

## Codes d'erreur

Enveloppe unique pour toutes les erreurs (`src/common/filters/all-exceptions.filter.ts`) :

```json
{
  "statusCode": 502,
  "error": "SOAP_FAULT",
  "message": "Le service externe a retourne une faute : Server was unable to process request. ---> Value was either too large or too small for a Decimal.",
  "correlationId": "b6f0c4a2-…",
  "timestamp": "2026-07-25T10:12:33.415Z",
  "path": "/api/v1/transfers",
  "reference": "TRF-20260725-C9ZV95SX",
  "details": { "faultCode": "soap:Server", "soapVersion": "1.1", "operation": "NumberToDollars" }
}
```

| HTTP | `error` | Cause |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | IBAN, montant, libellé, champ hors contrat |
| 400 | `CURRENCY_NOT_ALLOWED` | Devise absente de `ALLOWED_CURRENCIES` |
| 404 | `TRANSACTION_NOT_FOUND` | Référence inconnue |
| 409 | `IDEMPOTENCY_CONFLICT` | Course non résolue sur la clé d'idempotence |
| 422 | `AMOUNT_LIMIT_EXCEEDED` | Montant au-delà du plafond |
| 422 | `SAME_ACCOUNT_TRANSFER` | Donneur d'ordre = bénéficiaire |
| 502 | `SOAP_FAULT` | Le fournisseur a répondu par une `<soap:Fault>` |
| 502 | `SOAP_UNAVAILABLE` | Fournisseur injoignable (DNS, TCP, TLS) |
| 502 | `SOAP_INVALID_RESPONSE` | Réponse reçue mais inexploitable |
| 504 | `SOAP_TIMEOUT` | Délai dépassé après toutes les reprises |
| 500 | `INTERNAL_SERVER_ERROR` | Erreur non prévue — détail journalisé, jamais renvoyé |

Aucune trace d'exécution, requête SQL ni message de driver ne traverse la frontière HTTP.

---

## Intégration SOAP

### WSDL embarqué

Le WSDL est versionné dans [`src/soap/wsdl/NumberConversion.wsdl`](src/soap/wsdl/NumberConversion.wsdl)
et chargé depuis le disque. Trois bénéfices :

- le démarrage de l'API ne dépend d'aucun appel réseau ;
- les tests restent hermétiques ;
- le contrat est figé — une modification côté fournisseur devient un diff Git, pas une surprise en production.

`client.setEndpoint()` force ensuite l'adresse configurée, ce qui permet de viser un bouchon en recette
sans toucher au WSDL.

### Répartition des responsabilités

| Fichier | Responsabilité |
| --- | --- |
| `soap-client.service.ts` | Transport : création du client, timeout, reprises, capture de l'XML brut émis et reçu |
| `soap-response.mapper.ts` | Analyse : gardes de sécurité, parsing, normalisation des fautes, extraction du résultat |
| `exceptions/soap.exceptions.ts` | Traduction en exceptions du domaine (`Fault` / `Communication` / `Parsing`) |

Le client récupère l'XML brut via le tableau résolu par node-soap
(`[result, rawResponse, soapHeader, rawRequest]`) et le confie au mapper : l'analyse de la réponse
XML est donc réellement effectuée par le mapper, et la piste d'audit dispose des deux payloads.

### Gestion des fautes

Un fournisseur SOAP signale une faute par un **HTTP 500 portant une enveloppe `<soap:Fault>`** —
que node-soap remonte comme une erreur de transport. Le corps est donc repassé au mapper, qui
applique les mêmes gardes et la même normalisation que sur le chemin nominal. Conséquence
concrète : les entités XML sont correctement décodées (`---&gt;` → `--->`) dans le message rendu
au client.

Les formes SOAP 1.1 (`faultcode` / `faultstring`) et SOAP 1.2 (`Code/Value` + `Reason/Text`) sont
normalisées vers une structure unique `SoapFaultDetails`. Le WSDL du fournisseur exposant les deux
bindings, les deux cas sont couverts par les tests.

### Politique de reprise

Les reprises ne s'appliquent qu'aux **erreurs de communication**. Une `<soap:Fault>` est une réponse
métier : la rejouer serait au mieux inutile, au pire un doublon de paiement. Un backoff linéaire
(`SOAP_RETRY_DELAY_MS × tentative`) absorbe les indisponibilités brèves.

### Échantillons

Le dossier [`samples/`](samples/) contient les enveloppes réelles capturées ainsi que les payloads
hostiles utilisés par les tests :

| Fichier | Usage |
| --- | --- |
| `soap-request.xml` | Requête `NumberToDollars` émise |
| `soap-response.xml` | Réponse nominale réelle (noter le préfixe `m:`) |
| `soap-fault.xml` | Faute SOAP 1.1 |
| `soap-fault-12.xml` | Même incident en SOAP 1.2 |
| `soap-response-xxe.xml` | Déclaration d'entité externe — doit être rejetée |

---

## Sécurité et confidentialité

### Masquage des données sensibles

`src/common/utils/masking.util.ts` applique trois niveaux :

- **IBAN** → `FR76****0189` : pays et clé de contrôle conservés pour le diagnostic, corps du compte masqué ;
- **secrets** (`password`, `token`, `authorization`, `apiKey`…) → `[REDACTED]` intégral ;
- **texte libre et XML** → détection par motif, y compris hors des champs attendus.

Ce dernier point est le plus important : un IBAN glissé dans un commentaire ou une balise non
prévue est masqué quand même. La profondeur de récursion et la taille des tableaux sont bornées
pour qu'une structure hostile ne puisse pas faire boucler le masquage.

| Destination | IBAN complet ? |
| --- | --- |
| Table `transactions` | **Oui** — nécessaire à l'exécution du virement |
| Réponses HTTP | Non — masqué |
| Logs applicatifs | Non — masqué |
| Table `audit_logs` | Non — masqué puis tronqué |

Vérifié en exécution réelle : sur 445 lignes de log produites par un virement complet, **zéro**
occurrence d'IBAN en clair, 9 occurrences de la forme masquée.

### Durcissement du parseur XML

Un parseur XML est une surface d'attaque classique. Avant tout parsing, `SoapResponseMapper` rejette :

- `<!DOCTYPE` et `<!ENTITY` — XXE (lecture de fichiers locaux) et *billion laughs* ;
- `<?xml-stylesheet` — chargement de ressource externe ;
- toute réponse au-delà de `SOAP_MAX_RESPONSE_BYTES`.

Le rejet est explicite plutôt que délégué au comportement par défaut d'une dépendance tierce.

### Autres mesures

- `ValidationPipe` en `whitelist` + `forbidNonWhitelisted` : un champ hors contrat est un signe
  d'erreur d'intégration, pas un extra à ignorer silencieusement ;
- jeu de caractères SEPA imposé sur les libellés — rejette les caractères de contrôle et les
  fragments réinjectables dans un flux XML ;
- `helmet` pour les en-têtes HTTP ;
- identifiant de corrélation fourni par l'appelant validé par motif (évite l'injection de log) ;
- image Docker exécutée en utilisateur `node`, `dumb-init` pour la propagation de `SIGTERM`
  (arrêt propre du pool PostgreSQL via `enableShutdownHooks`).

---

## Modèle de données

### `transactions`

Référence unique, clé d'idempotence unique, statut (`PENDING` → `PROCESSING` → `COMPLETED` / `FAILED`),
IBAN, montant `numeric(18,2)`, devise, montant en lettres, métadonnées SOAP (opération, durée,
tentatives, code et motif de faute), `correlationId`, horodatages, et `@VersionColumn` pour le
verrouillage optimiste.

### `audit_logs`

Sens de l'échange (`OUTBOUND_REQUEST`, `INBOUND_RESPONSE`, `INBOUND_FAULT`, `COMMUNICATION_ERROR`),
issue, opération, payload masqué, taille du payload d'origine, durée, code de faute, corrélation.

L'écriture d'audit est **best-effort** : un échec de persistance est journalisé mais ne fait jamais
échouer la transaction métier.

### Contrats XSD

[`schemas/transfer-request.xsd`](schemas/transfer-request.xsd) et
[`schemas/transfer-response.xsd`](schemas/transfer-response.xsd) formalisent le contrat pour les
intégrateurs travaillant en XML ou générant des stubs. Les décorateurs `class-validator` en sont la
transposition exécutable.

La clé de contrôle MOD 97-10 n'étant pas exprimable en XSD 1.0, elle reste vérifiée
par `IsIbanConstraint` — le XSD ne valide que la structure.

---

## Tests

```bash
npm test          # 108 tests unitaires
npm run test:e2e  # 34 tests d'intégration (PostgreSQL requis)
npm run test:cov  # couverture
```

Les tests e2e utilisent la base `banking_soap_test` et **bouchonnent le client SOAP** : ils sont
déterministes et hors ligne, y compris pour les scénarios de faute et de timeout.

```bash
createdb banking_soap_test
psql -d banking_soap_test -c 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp";'
```

Couverture notable :

- **IBAN** — 9 pays valides, clé de contrôle altérée, longueur pays non conforme, entrées hostiles ;
- **Masquage** — fuite via clé inattendue, texte libre, XML préfixé, structures profondes ;
- **Mapper** — réponse réelle, préfixes de namespace variables, fautes 1.1 et 1.2, `<soap:Fault/>` vide,
  XXE, *billion laughs*, dépassement de taille, XML malformé, enveloppe ou résultat absents ;
- **Service** — ordre de persistance avant appel externe, idempotence (rejeu et course), collision
  de référence, chaque mode d'échec SOAP, non-divulgation du détail technique ;
- **e2e** — cycle complet, validation, idempotence, 502/504 avec référence consultable, pagination,
  audit masqué, corrélation, santé.

Deux tests ont mis en évidence de vrais défauts pendant le développement, corrigés depuis :

1. un `<soap:Fault/>` vide n'était pas reconnu comme faute (xml2js le rend en chaîne vide) ;
2. après résolution d'une course d'idempotence, la transaction gagnante était retraitée — soit un
   **second appel SOAP pour un seul virement**.

---

## Validation en conditions réelles

Au-delà des tests, les chemins suivants ont été exercés contre le vrai service public et contre un
bouchon local :

| Scénario | Résultat observé |
| --- | --- |
| Virement nominal, service DataAccess réel | `201` · `COMPLETED` · `"one thousand two hundred and fifty dollars and seventy five cents"` · 1865 ms |
| Rejeu avec la même `Idempotency-Key` | Référence identique, **aucun** second appel SOAP |
| Timeout (`SOAP_TIMEOUT_MS=100`) | `504 SOAP_TIMEOUT` · 3 tentatives · statut `FAILED` · audit `COMMUNICATION_ERROR` |
| Faute SOAP 1.1 (bouchon, HTTP 500) | `502 SOAP_FAULT` · **aucune** reprise · `faultCode` persisté |
| Faute SOAP 1.2 (bouchon) | Normalisée vers la même structure, `soapVersion: "1.2"` |
| Configuration invalide au boot | Démarrage refusé avec le motif exact |
| Fuite d'IBAN (logs + base d'audit) | Aucune |

---

## Migrations

`DB_SYNCHRONIZE` est réservé au développement. En production :

```bash
npm run migration:generate -- src/database/migrations/InitialSchema
npm run migration:run
npm run migration:revert
```

La `DataSource` de la CLI est `src/database/data-source.ts`.

---

## Arborescence

```
banking-soap-integration-demo/
├── src/
│   ├── transactions/          # Domaine métier
│   │   ├── transactions.controller.ts
│   │   ├── transactions.service.ts      ← orchestration
│   │   ├── transactions.repository.ts
│   │   ├── reference.generator.ts
│   │   ├── entities/ · enums/ · dto/
│   ├── soap/                  # Couche anti-corruption
│   │   ├── soap-client.service.ts       ← transport, reprises
│   │   ├── soap-response.mapper.ts      ← analyse XML, fautes
│   │   ├── exceptions/ · wsdl/
│   ├── audit/                 # Piste d'audit
│   ├── common/
│   │   ├── filters/           # Enveloppe d'erreur unique
│   │   ├── interceptors/      # Journalisation masquée
│   │   ├── validators/        # IsIban, IsMonetaryAmount
│   │   ├── middleware/ · context/ · utils/ · dto/
│   ├── config/                # Configuration typée + validation d'env
│   ├── database/ · health/
│   ├── app.module.ts · main.ts
├── schemas/                   # transfer-request.xsd, transfer-response.xsd
├── samples/                   # Enveloppes réelles + payloads hostiles
├── test/                      # Tests d'intégration
├── docker/postgres/init/
├── docker-compose.yml · Dockerfile
├── .env.example · README.md
```

---

## Limites assumées

Ce dépôt est une démonstration d'intégration, pas un service de paiement.

- **Aucune authentification.** Une mise en production exigerait au minimum OAuth2/mTLS, une
  autorisation par scope et une limitation de débit.
- **Aucun débit réel.** Le service SOAP ne fait que convertir un montant en lettres ; il ne
  contacte aucun système de règlement.
- **Traitement synchrone.** Un vrai back-office bancaire répond en quelques secondes à quelques
  minutes : le modèle cible serait une file de messages avec reprise durable, plutôt qu'un appel
  bloquant dans le cycle HTTP.
- **IBAN stockés en clair.** En production, ils relèveraient d'un chiffrement au repos ou d'un
  coffre à jetons.
- **Pas de purge.** La piste d'audit croît indéfiniment ; une politique de rétention serait requise.
