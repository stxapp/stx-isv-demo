// Optional Google Analytics 4. The measurement id comes from GA_MEASUREMENT_ID
// at runtime and reaches the browser through GET /api/app, so one build serves
// every environment and a fork sends nothing unless it sets its own id.
//
// Only a well-formed GA4 id ("G-" and letters/digits) is passed on: the
// browser puts it in a script URL, so anything else is treated as unset.
export function gaMeasurementIdFrom(raw: string | undefined | null): string | null {
  const v = (raw ?? "").trim().toUpperCase();
  return /^G-[A-Z0-9]{4,20}$/.test(v) ? v : null;
}

// A comma-separated list of host names (GA_IGNORE_REFERRER_DOMAINS,
// GA_LINKED_DOMAINS): trimmed, lower-cased, de-duplicated. Entries that are
// not plain host names are dropped. Unset or empty: [].
export function gaDomainsFrom(raw: string | undefined | null): string[] {
  return listFrom(raw, (v) => v.toLowerCase().replace(/^\.+/, ""), /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
}

// A comma-separated list of ISO 3166 region codes where analytics starts
// denied (GA_CONSENT_REQUIRED_REGIONS), e.g. "GB,CA-QC". Unset or empty: [].
export function gaRegionsFrom(raw: string | undefined | null): string[] {
  return listFrom(raw, (v) => v.toUpperCase(), /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/);
}

function listFrom(raw: string | undefined | null, norm: (v: string) => string, valid: RegExp): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const v = norm(part.trim());
    if (valid.test(v) && !out.includes(v)) out.push(v);
  }
  return out;
}
