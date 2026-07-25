# syntax=docker/dockerfile:1

# ==============================================================================
# Etape 1 — dependances de build
# ==============================================================================
FROM node:22-alpine AS deps

WORKDIR /app

COPY package*.json ./
RUN npm ci

# ==============================================================================
# Etape 2 — compilation TypeScript
# ==============================================================================
FROM node:22-alpine AS build

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package*.json tsconfig*.json nest-cli.json ./
COPY src ./src

# `nest build` copie egalement le WSDL embarque vers dist/soap/wsdl (nest-cli.json).
RUN npm run build

# ==============================================================================
# Etape 3 — dependances de production uniquement
# ==============================================================================
FROM node:22-alpine AS prod-deps

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ==============================================================================
# Etape 4 — image finale
# ==============================================================================
FROM node:22-alpine AS runtime

# `dumb-init` assure la propagation de SIGTERM : indispensable pour que
# `app.enableShutdownHooks()` ferme proprement le pool PostgreSQL.
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# Les XSD sont lus a l'execution par XsdValidatorService : ils vivent a la
# racine, hors de `src/`, et ne sont donc pas emportes par `nest build`.
COPY --chown=node:node schemas ./schemas

# Scripts de deploiement du contrat : utilises par le service `contract-deployer`
# de docker-compose, qui partage cette meme image.
COPY --chown=node:node scripts ./scripts

# Ne jamais executer l'API en root.
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('node:http').get({host:'127.0.0.1',port:process.env.PORT||3000,path:'/'+(process.env.API_PREFIX||'api/v1')+'/health',timeout:4000},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main"]
