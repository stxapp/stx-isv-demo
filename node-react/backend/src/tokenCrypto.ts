// Encryption at rest for the STX tokens in account_links.
//
// With TOKEN_ENCRYPTION_KEY set (32 bytes, base64), each token is stored as
// `enc:v1:<iv>:<ciphertext+tag>` under AES-256-GCM. Without it (local dev),
// tokens are stored as they are. Reads accept both forms, so turning the key on
// does not strand existing links.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";

function keyFromEnv(): Buffer | null {
  const raw = process.env.TOKEN_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  return key;
}

export function sealToken(plain: string): string {
  const key = keyFromEnv();
  if (!key) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `${PREFIX}${iv.toString("base64url")}:${body.toString("base64url")}`;
}

export function openToken(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored;
  const key = keyFromEnv();
  if (!key) throw new Error("token is encrypted but TOKEN_ENCRYPTION_KEY is not set");
  const [ivPart, bodyPart] = stored.slice(PREFIX.length).split(":");
  const body = Buffer.from(bodyPart ?? "", "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivPart ?? "", "base64url"));
  decipher.setAuthTag(body.subarray(body.length - 16));
  return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString("utf8");
}
