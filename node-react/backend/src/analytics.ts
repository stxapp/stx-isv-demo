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
