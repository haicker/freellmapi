FROM node:22-slim AS builder

WORKDIR /app

# Copy workspace root + package manifests first for layer caching
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/

RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# --- Runtime stage ---
FROM node:22-slim

WORKDIR /app

# Copy built artifacts + runtime deps only
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/

RUN npm ci --omit=dev

COPY --from=builder /app/server/dist server/dist/
COPY --from=builder /app/client/dist client/dist/
COPY shared/ shared/

# SQLite data directory (mounted as a volume in compose)
RUN mkdir -p server/data

ENV NODE_ENV=production
ENV PORT=3001
ENV HOST=0.0.0.0
EXPOSE 3001

CMD ["node", "server/dist/index.js"]
