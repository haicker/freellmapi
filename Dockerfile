# ── Stage 1: builder ──────────────────────────────────────────────
# Compile both server (tsc) and client (vite). Build tools for native
# modules (better-sqlite3) are installed here and discarded afterwards.
FROM node:24-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy all source (npm workspaces: shared / server / client)
COPY . .

# Install all dependencies (dev + prod) needed for building
RUN npm ci

# Build both workspaces. A compile failure must stop the image build so a broken
# server cannot be published as `latest`.
RUN npm run build

# ── Stage 2: deps ────────────────────────────────────────────────
# Install ONLY server + shared production dependencies. Client deps
# (react, recharts, tailwindcss …) are skipped because the dashboard
# is already compiled to static files in Stage 1.
FROM node:24-slim AS deps

# Build tools are needed in case better-sqlite3 has no prebuilt binary
# for the current Node ABI; they never reach the final image.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy only the manifest files needed for installation
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY shared/package.json ./shared/

# Remove "client" from the workspaces list so its dependencies are
# excluded from the installation entirely.
RUN node -e "const p=require('./package.json');p.workspaces=p.workspaces.filter(w=>w!=='client');require('fs').writeFileSync('./package.json',JSON.stringify(p,null,2)+'\n')"

RUN npm install --omit=dev

# ── Stage 3: runner ──────────────────────────────────────────────
# Minimal final image: Node runtime + compiled artifacts + server deps.
FROM node:24-slim AS runner

WORKDIR /app

# Production node_modules (server-only, with compiled better-sqlite3)
COPY --from=deps /app/node_modules ./node_modules

# Compiled server code
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/server/package.json ./server/package.json

# Compiled client static assets (served by the server at runtime)
COPY --from=builder /app/client/dist ./client/dist

# Shared types (type-only imports are erased at runtime, but kept for safety)
COPY --from=builder /app/shared ./shared

# SQLite data directory (mounted as a volume in compose)
RUN mkdir -p server/data

ENV NODE_ENV=production
ENV PORT=3001
ENV HOST=0.0.0.0
EXPOSE 3001

CMD ["node", "server/dist/index.js"]
