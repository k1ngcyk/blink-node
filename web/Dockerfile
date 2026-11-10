# Compile JavaScript once on the builder's native architecture.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build-base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM build-base AS dependencies
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

FROM dependencies AS builder
COPY . .
RUN npm run build && rm -rf .next/standalone/node_modules

# Select the target platform's prebuilt native modules without executing them.
# The locked production graph uses optional packages for sharp/SWC/esbuild.
FROM build-base AS production-dependencies
ARG TARGETARCH
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    case "$TARGETARCH" in amd64) cpu=x64;; arm64) cpu=arm64;; *) exit 1;; esac \
    && npm ci --omit=dev --ignore-scripts --os=linux --cpu="$cpu" --libc=glibc --no-audit --no-fund

FROM node:24-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS gateway
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates iputils-ping && rm -rf /var/lib/apt/lists/*
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src/db ./src/db
COPY src/server ./src/server
COPY realtime ./realtime
COPY scripts ./scripts
COPY drizzle ./drizzle
USER node
CMD ["node", "--import", "tsx", "realtime/index.ts"]

FROM base AS web
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]

# One published image supports Web, gateway, migrations and administrator setup.
# Each remains a separate least-privilege Compose service/process.
FROM gateway AS runtime
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
