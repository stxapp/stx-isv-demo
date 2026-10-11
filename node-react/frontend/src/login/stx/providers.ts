import type { Connection } from "./signIn";

// Shortcuts past STX's own page, each in its provider's own branding, from the
// unmodified marks in public/assets/providers; stacked Google, Apple, X.
export const PROVIDERS: { connection: Connection; label: string; logo: string }[] = [
  { connection: "google", label: "Continue with Google", logo: "/assets/providers/google-g.svg" },
  { connection: "apple", label: "Continue with Apple", logo: "/assets/providers/apple-logo-black.svg" },
  { connection: "x", label: "Continue with X", logo: "/assets/providers/x-logo-white.svg" },
];
