import { startLink } from "../api";

// The one "link your STX account" call to action, used wherever a member can
// link (the wallet's STX tile, the betslip). A real button: keyboard focusable,
// with hover and focus states, an icon, and an optional one-line hint.
export function LinkStxButton({
  appName,
  hint = true,
  block = false,
  className = "",
}: {
  // The ISV app the member is in, for the hint ("Trade on STX from Sideline").
  appName?: string;
  hint?: boolean;
  block?: boolean;
  className?: string;
}) {
  return (
    <div className={`link-cta-wrap${block ? " block" : ""} ${className}`.trim()}>
      <button type="button" className="link-cta" onClick={startLink}>
        <LinkIcon />
        <span>Link your STX account</span>
      </button>
      {hint && (
        <p className="link-cta-hint">
          Trade on STX from {appName ?? "this app"}. You'll sign in to STX and approve access.
        </p>
      )}
    </div>
  );
}

function LinkIcon() {
  return (
    <svg className="link-cta-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
