# Single-container production image for the STX ISV demo.
#
# Builds the Vite/React frontend to static assets, then runs the Bun backend
# (the confidential OAuth client) which also serves those assets, so the whole
# demo is one origin: cookies are same-site and the browser calls /api and
# /login relatively. VITE_* are baked at build time; the backend's STX/OAuth
# config comes from runtime env.

# --- Stage 1: build the frontend ---
FROM node:20-alpine AS frontend
WORKDIR /fe
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
# Same-origin: the browser calls the backend relatively (""), and STX directly.
ARG VITE_STX_HTTP_URL
ARG VITE_STX_WS_URL
ENV VITE_BACKEND_URL="" \
    VITE_STX_HTTP_URL=$VITE_STX_HTTP_URL \
    VITE_STX_WS_URL=$VITE_STX_WS_URL
RUN npm run build

# --- Stage 2: backend + static assets ---
FROM oven/bun:1.1-slim
WORKDIR /app
COPY backend/package.json ./
RUN bun install
COPY backend/tsconfig.json ./
COPY backend/src ./src
# Built frontend served from ./public by the backend (see index.ts).
COPY --from=frontend /fe/dist ./public
RUN mkdir -p /app/data
EXPOSE 8787
CMD ["bun", "run", "src/index.ts"]
