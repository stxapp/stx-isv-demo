# Bun backend — the confidential OAuth client.
FROM oven/bun:1.1-slim

WORKDIR /app

# Install deps first for layer caching.
COPY package.json ./
# No lockfile is committed for the demo; resolve on build.
RUN bun install

COPY tsconfig.json ./
COPY src ./src

# SQLite lives under /app/data, mounted as a volume in docker-compose.
RUN mkdir -p /app/data

EXPOSE 8787

CMD ["bun", "run", "src/index.ts"]
