import { startLink } from "../api";
import { StxLogoOnBrand } from "./PoweredByStx";

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
  return (
    <div className={`link-cta-wrap${block ? " block" : ""} ${className}`.trim()}>
      <button type="button" className="link-cta" onClick={startLink}>
        <StxLogoOnBrand className="link-cta-logo" />
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
