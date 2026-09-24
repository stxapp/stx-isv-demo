// Reconnect pacing for the STX socket proxies (liveProxy, marketProxy).
//
// A dropped socket is retried on an exponential schedule with jitter, not a
// fixed timer: 1s, 2s, 4s ... capped at 30s, each spread over 50-150% of its
// nominal value so a fleet of subscriptions that lost STX at the same moment
// does not come back at the same moment. During an STX outage this turns
// "every subscription reconnects twice a second" into "every subscription
// reconnects about twice a minute". The attempt counter resets once a socket
// joins successfully, so a single blip still recovers in a second.

export const BASE_DELAY_MS = 1000;
export const MAX_DELAY_MS = 30_000;

// Delay before reconnect attempt number `attempt` (0 = the first retry).
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponent = Math.min(Math.max(attempt, 0), 30);
  const nominal = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** exponent);
  const jitter = 0.5 + random(); // 0.5 .. 1.5
  return Math.round(Math.min(MAX_DELAY_MS, nominal * jitter));
}
