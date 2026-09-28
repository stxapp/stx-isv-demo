import { useEffect, useState } from "react";
import { analyticsConfigured, consentChoice, onAnalyticsChange, setConsent } from "../analytics";

// Asks once whether anonymous usage statistics may be collected. Shown only
// when the deployment has a Google Analytics id and no choice is stored yet,
// or when reopened from the footer's "Usage statistics" link.
export function ConsentBanner({ reopen, onClose }: { reopen: boolean; onClose: () => void }) {
  const [, setTick] = useState(0);
  useEffect(() => onAnalyticsChange(() => setTick((t) => t + 1)), []);

  const choice = consentChoice();
  if (!analyticsConfigured() || (choice !== null && !reopen)) return null;

  const decide = (c: "granted" | "denied") => {
    setConsent(c);
    onClose();
  };

  return (
    <div className="consent" role="dialog" aria-live="polite" aria-label="Usage statistics">
      <p className="consent-text">
        May Sideline collect anonymous usage statistics (Google Analytics)? No names, emails or account ids,
        and nothing loads unless you accept.
        {choice && <span className="consent-current"> Currently: {choice === "granted" ? "accepted" : "declined"}.</span>}
      </p>
      <div className="consent-actions">
        <button type="button" className="consent-btn" onClick={() => decide("denied")}>
          Decline
        </button>
        <button type="button" className="consent-btn consent-accept" onClick={() => decide("granted")}>
          Accept
        </button>
      </div>
    </div>
  );
}
