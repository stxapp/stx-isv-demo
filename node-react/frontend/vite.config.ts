import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dev server runs on :5173. Requests to the backend go to VITE_BACKEND_URL
// (default http://localhost:8787) directly, with credentials, so the session
// cookie is sent: see src/api.ts.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
  },
});
