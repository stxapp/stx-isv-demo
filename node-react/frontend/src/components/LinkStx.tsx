import { startLink } from "../api";
import { StxLogo } from "./PoweredByStx";

// The words on the button, per login mode (set once at boot from login/linkCopy).
type LinkCopy = (appName: string) => { label: string; hint: string };
let copyFor: LinkCopy = (appName) => ({
  label: "Connect your STX account",
  hint: `Trade on STX from ${appName}. You'll sign in to STX and approve access.`,
});
export function setLinkCopy(fn: LinkCopy): void {
  copyFor = fn;
}

// The one "link your STX account" call to action, used wherever a member can
// link (the wallet's STX tile, the betslip). A real button: keyboard focusable,
// with hover and focus states, the STX logo, and an optional one-line hint.
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
  const copy = copyFor(appName ?? "this app");
  return (
    <div className={`link-cta-wrap${block ? " block" : ""} ${className}`.trim()}>
      <button type="button" className="link-cta" onClick={startLink}>
        {/* Decorative: the label already says STX. */}
        <StxLogo alt="" className="link-cta-logo" />
        <span>{copy.label}</span>
      </button>
      {hint && (
        <p className="link-cta-hint">
          {copy.hint}
        </p>
      )}
    </div>
  );
}
