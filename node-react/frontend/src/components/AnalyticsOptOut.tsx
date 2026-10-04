import { useEffect, useState } from "react";
import { analyticsConfigured, consentChoice, onAnalyticsChange, setConsent } from "../analytics";

// The footer's usage-statistics switch. Shown only when the deployment has a
// Google Analytics id; opting out stops collection now and on later visits.
export function AnalyticsOptOut() {
  const [, setTick] = useState(0);
  useEffect(() => onAnalyticsChange(() => setTick((t) => t + 1)), []);

  if (!analyticsConfigured()) return null;
  const optedOut = consentChoice() === "denied";

  return (
    <p className="muted analytics-note">
      Anonymous usage statistics (Google Analytics), no names, emails or account ids.{" "}
      <button type="button" className="link" onClick={() => setConsent(optedOut ? "granted" : "denied")}>
        {optedOut ? "Allow usage statistics" : "Opt out of usage statistics"}
      </button>
    </p>
  );
}
