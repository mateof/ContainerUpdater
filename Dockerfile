# syntax=docker/dockerfile:1.7
#
# Imagen multi-arquitectura de ContainerUpdater.
#
# Idea central: solo la etapa que compila codigo nativo se emula bajo QEMU. Las
# etapas de Vite y TypeScript llevan --platform=$BUILDPLATFORM porque son lo
# caro del build y emularlas multiplica el tiempo por cinco o por diez.

ARG NODE_VERSION=22

# ---------------------------------------------------------------------------
# 1. Frontend. JavaScript puro: la arquitectura de destino da igual, asi que se
#    compila siempre en la plataforma nativa del que construye.
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS web-build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
RUN npm ci --ignore-scripts
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build -w @cu/web

# ---------------------------------------------------------------------------
# 2. Backend TypeScript a JavaScript. Tambien independiente de la arquitectura.
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS server-build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
RUN npm ci --ignore-scripts
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN npm run build -w @cu/server

# ---------------------------------------------------------------------------
# 3. Dependencias de produccion. Esta SI se emula: better-sqlite3 compila desde
#    fuente y el binario resultante tiene que ser de la arquitectura de destino.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS server-deps
WORKDIR /repo
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
RUN npm ci --omit=dev --workspace @cu/server --include-workspace-root \
 && npm cache clean --force

# ---------------------------------------------------------------------------
# 4. Runtime
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

# bookworm-slim y no Alpine: better-sqlite3 se compila desde fuente y builder y
# runtime tienen que compartir libc, o el .node no carga. glibc da un build mas
# predecible que musl a cambio de unos pocos MB.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini tzdata \
 && rm -rf /var/lib/apt/lists/*

# El CLI de Docker y el plugin de Compose se copian de las imagenes oficiales,
# que son multi-arquitectura: COPY --from elige sola la variante correcta. Las
# versiones van fijadas a proposito, porque un salto mayor de Compose podria
# cambiar la semantica de las labels de las que depende la deteccion de
# proyectos.
COPY --from=docker:28-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker/compose-bin:v2.32.4 /docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose

WORKDIR /app
COPY --from=server-deps  /repo/node_modules ./node_modules
COPY --from=server-build /repo/apps/server/dist ./dist
COPY --from=web-build    /repo/apps/web/dist ./public

ENV NODE_ENV=production \
    PORT=8080 \
    CU_DATA_DIR=/data \
    CU_PUBLIC_DIR=/app/public \
    CU_HOST_PROC=/host/proc

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD ["node", "dist/healthcheck.js"]

# tini como PID 1: `docker compose` lanza procesos hijo y sin un reaper quedan
# zombis. Ademas propaga SIGTERM, sin lo cual el contenedor tarda diez segundos
# en morir en cada parada.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]

LABEL org.opencontainers.image.title="ContainerUpdater" \
      org.opencontainers.image.description="Panel para vigilar y actualizar las imagenes Docker de un NAS Synology" \
      org.opencontainers.image.source="https://github.com/mateof/ContainerUpdater" \
      org.opencontainers.image.licenses="MIT"
