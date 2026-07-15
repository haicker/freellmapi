FROM node:22-slim

WORKDIR /app

# Copy all source (npm workspaces: shared / server / client)
COPY . .

# Install all dependencies and build
RUN npm ci
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
