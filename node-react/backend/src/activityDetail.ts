// The request and response behind one activity row, made safe to store and
// show: secrets redacted, long lists cut to their first items, large bodies
// truncated. The SDK hands the bodies over unredacted (ResponseEvent
// `requestBody` / `responseBody`), so everything that reaches the activity
// table goes through `buildDetail` first.
//
// Nothing here stores headers: the Authorization / x-stx-oauth-token headers
// never reach the log at all.

// Keys whose values are always replaced, wherever they appear.
const SECRET_KEY =
  /^(authorization|x-stx-oauth-token|x-stx-access-signature|access_token|refresh_token|id_token|client_secret|code|code_verifier|password|private_key|privatekey|secret|token|assertion|client_assertion|api_key|signature)$/i;
// And any key that names a token, secret, password, verifier or key material.
const SECRET_KEY_PART = /(token|secret|password|verifier|private|pem|credential)/i;

// Secret-shaped values, redacted even under an innocent key.
const PEM = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(-----END [A-Z0-9 ]+-----|$)/g;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
// The exchange's opaque OAuth tokens and client secrets.
const STX_TOKEN = /\bstx_(at|rt|secret|sk|pat)_[A-Za-z0-9._-]+/gi;

export const REDACTED = "[redacted]";

// Items kept from a list before the rest are summarised.
export const LIST_ITEMS = 10;
// Stored size cap for one body, in characters of pretty JSON.
export const BODY_LIMIT = 20_000;

// Client IP addresses (STX echoes the order's source IP): never shown.
const IP_KEY = /^(ip|ip_address|ipaddress|client_ip|remote_ip|remote_addr|x_forwarded_for|x-forwarded-for|forwarded_for|x_real_ip|x-real-ip)$/i;

// Keys that name a token or secret but carry none.
const NOT_SECRET = /^(token_type|token_endpoint_auth_method|requested_token_type|issued_token_type)$/i;

export function isSecretKey(key: string): boolean {
  if (IP_KEY.test(key)) return true;
  if (NOT_SECRET.test(key)) return false;
  return SECRET_KEY.test(key) || SECRET_KEY_PART.test(key);
}

export function redactString(s: string): string {
  return s
    .replace(PEM, "[redacted key material]")
    .replace(JWT, REDACTED)
    .replace(BEARER, `$1 ${REDACTED}`)
    .replace(STX_TOKEN, REDACTED);
}

// A deep copy with secrets replaced and long lists cut to their first items.
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[nested too deep]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) {
    const kept = value.slice(0, LIST_ITEMS).map((v) => redact(v, depth + 1));
    if (value.length > LIST_ITEMS) {
      kept.push(`… ${value.length - LIST_ITEMS} more (${value.length} items in total)`);
    }
    return kept;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) && v !== null && v !== undefined && v !== "" ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

// A body as sent or received: JSON, a form (the OAuth token endpoint), or text.
export function parseBody(raw: string | null | undefined): unknown {
  if (raw === null || raw === undefined || raw === "") return undefined;
  const t = raw.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t);
    } catch {
      // Not JSON after all: fall through to text.
    }
  }
  if (/^[\w.-]+=[^&\s]*(&[\w.-]+=[^&\s]*)*$/.test(t)) {
    return Object.fromEntries(new URLSearchParams(t));
  }
  return t;
}

export interface BodyDetail {
  // The redacted body: JSON, or text when it was cut.
  body?: unknown;
  // Set when the body was over BODY_LIMIT and only its start is kept.
  truncated?: boolean;
  // Size of the original body, in characters.
  size?: number;
}

// A redacted, size-capped body. Redaction happens before truncation, so a cut
// can never leave half a secret behind.
export function safeBody(raw: unknown): BodyDetail {
  if (raw === undefined) return {};
  const parsed = typeof raw === "string" ? parseBody(raw) : raw;
  if (parsed === undefined) return {};
  const clean = redact(parsed);
  const text = typeof clean === "string" ? clean : JSON.stringify(clean, null, 2);
  const size = typeof raw === "string" ? raw.length : text.length;
  if (text.length > BODY_LIMIT) {
    return { body: text.slice(0, BODY_LIMIT), truncated: true, size };
  }
  return { body: clean, size };
}

// A path with its query parsed and redacted (e.g. ?code=… never kept).
export function safePath(pathWithQuery: string): { path: string; query?: Record<string, unknown> } {
  const i = pathWithQuery.indexOf("?");
  if (i < 0) return { path: pathWithQuery };
  const path = pathWithQuery.slice(0, i);
  const params = new URLSearchParams(pathWithQuery.slice(i + 1));
  const query: Record<string, unknown> = {};
  for (const [k, v] of params) {
    const val = isSecretKey(k) ? REDACTED : redactString(v);
    const prev = query[k];
    query[k] = prev === undefined ? val : Array.isArray(prev) ? [...prev, val] : [prev, val];
  }
  return { path, query };
}

export interface ActivityDetail {
  request?: { method: string; path: string; query?: Record<string, unknown> } & BodyDetail;
  response?: { status: number | null; summary?: string } & BodyDetail;
  // For socket rows: what was joined, and what the join returned.
  note?: string;
}

// "orders: 42 items" for each list in a body, so a cut list still says its size.
export function listSummary(body: unknown): string | undefined {
  const parsed = typeof body === "string" ? parseBody(body) : body;
  if (Array.isArray(parsed)) return `${parsed.length} items`;
  if (!parsed || typeof parsed !== "object") return undefined;
  const parts = Object.entries(parsed as Record<string, unknown>)
    .filter(([, v]) => Array.isArray(v))
    .map(([k, v]) => `${k}: ${(v as unknown[]).length} items`);
  return parts.length ? parts.join(", ") : undefined;
}

// The detail for one HTTP exchange, ready to store.
export function buildDetail(input: {
  method: string;
  path: string;
  requestBody?: unknown;
  status: number | null;
  responseBody?: unknown;
  summary?: string;
}): ActivityDetail {
  const summary = input.summary ?? listSummary(input.responseBody);
  return {
    request: { method: input.method, ...safePath(input.path), ...safeBody(input.requestBody) },
    response: { status: input.status, ...(summary ? { summary } : {}), ...safeBody(input.responseBody) },
  };
}

// The stored form: JSON text, redacted once more as a whole as a last guard.
export function serializeDetail(detail: ActivityDetail | null | undefined): string | null {
  if (!detail) return null;
  return redactString(JSON.stringify(redact(detail)));
}
