/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Backend base URL (the confidential OAuth client). Default http://localhost:8787.
  readonly VITE_BACKEND_URL?: string;
  // STX WebSocket base for the public market-data feed. Default ws://localhost:4000.
  readonly VITE_STX_WS_URL?: string;
  // STX HTTP base for the public GraphQL market catalog. Default http://localhost:4000.
  readonly VITE_STX_HTTP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
