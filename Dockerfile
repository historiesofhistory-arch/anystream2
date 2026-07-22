# ── Stage 1: Builder ─────────────────────────────────────────────────────────
# Builds the self-contained esbuild bundle (dist/index.mjs + pino workers).
FROM node:24-slim AS builder

# Install pnpm (matches workspace version)
RUN npm install -g pnpm@10

WORKDIR /app

# Copy workspace manifests first so Docker layer-caches dependency installs
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json ./

# Only the packages the api-server build actually needs
COPY lib/api-zod/   lib/api-zod/
COPY lib/db/        lib/db/
COPY artifacts/api-server/ artifacts/api-server/

# Install all deps (workspace-aware, frozen)
RUN pnpm install --frozen-lockfile

# Build → produces artifacts/api-server/dist/
RUN pnpm --filter @workspace/api-server run build

# ── Stage 2: Production runner ────────────────────────────────────────────────
# Copies only the bundled output — no node_modules, no source, no toolchain.
FROM node:24-slim AS runner

# Non-root user for security
RUN groupadd --gid 1001 nodejs \
 && useradd  --uid 1001 --gid nodejs --shell /bin/bash --create-home nodejs

WORKDIR /app

# esbuild bundles everything; only the dist dir is needed at runtime
COPY --from=builder --chown=nodejs:nodejs /app/artifacts/api-server/dist/ ./dist/

USER nodejs

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# --enable-source-maps gives readable stack traces from the bundled file
CMD ["node", "--enable-source-maps", "./dist/index.mjs"]
