/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Backend base URL (the confidential OAuth client). Default http://localhost:8787.
  // Market data (catalog + live feeds) is now served through this backend.
  readonly VITE_BACKEND_URL?: string;
  // STX HTTP base — only for links that open the STX site itself (deposit,
  // "powered by"), no longer for market data. Default http://localhost:4000.
  readonly VITE_STX_HTTP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
