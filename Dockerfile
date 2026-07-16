FROM node:24-slim

# Install build tools for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy all source (npm workspaces: shared / server / client)
COPY . .

# Install all dependencies
RUN npm ci

# Build both workspaces. A compile failure must stop the image build so a broken
# server cannot be published as `latest`.
RUN npm run build

# Remove dev dependencies to slim down the image
RUN npm prune --omit=dev

# SQLite data directory (mounted as a volume in compose)
RUN mkdir -p server/data

ENV NODE_ENV=production
ENV PORT=3001
ENV HOST=0.0.0.0
EXPOSE 3001

CMD ["node", "server/dist/index.js"]
