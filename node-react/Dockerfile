# Single-container production image for the STX demo app.
#
# Builds the Vite/React frontend to static assets, then runs the Bun backend
# (the confidential OAuth client) which also serves those assets, so the whole
# demo is one origin: cookies are same-site and the browser calls /api and
# /login relatively. Nothing host-specific is baked in: the exchange's address,
# this app's public URL, its name and its login mode (LOGIN_MODE) all come from
# runtime env, so one image runs on any host, as any of the demo apps.

# --- Stage 1: build the frontend ---
FROM node:20-alpine AS frontend
WORKDIR /fe
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
# Same-origin: the browser calls the backend relatively (""). The exchange's
# public address reaches the browser at runtime from GET /api/app.
ENV VITE_BACKEND_URL=""
RUN npm run build

# --- Stage 2: backend + static assets ---
FROM oven/bun:1.1-slim
WORKDIR /app
COPY backend/package.json ./
# The STX TypeScript SDK (@stxapp/stx-typescript) is installed from npm.
RUN bun install
COPY backend/tsconfig.json ./
COPY backend/src ./src
# Built frontend served from ./public by the backend (see index.ts).
COPY --from=frontend /fe/dist ./public
RUN mkdir -p /app/data
EXPOSE 8787
CMD ["bun", "run", "src/index.ts"]
