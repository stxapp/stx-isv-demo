// "Powered by STX" attribution and the other places the STX logo appears. The
// official STX logos (light and dark theme versions, src/assets/stx-logo-*.svg)
// and the STX mark (the X of the same logos, stx-mark-*.svg) are imported (not
// from /public) so Vite emits them under /assets, which the public preview WAF
// allows.
//
// Each logo renders both theme versions and CSS shows the one that matches
// data-theme on <html> (see .theme-light-only / .theme-dark-only), so it follows
// the header toggle and the OS preference with no re-render. The hidden version
// is display:none, so assistive tech only ever sees one accessible name.
import stxLogoLight from "../assets/stx-logo-light.svg";
import stxLogoDark from "../assets/stx-logo-dark.svg";
import stxMarkLight from "../assets/stx-mark-light.svg";
import stxMarkDark from "../assets/stx-mark-dark.svg";
import { stxUrl } from "../publicMarketData";

function Themed({ light, dark, alt, className }: { light: string; dark: string; alt: string; className: string }) {
  const hidden = alt ? undefined : true;
  return (
    <>
      <img src={light} alt={alt} className={`${className} theme-light-only`} aria-hidden={hidden} />
      <img src={dark} alt={alt} className={`${className} theme-dark-only`} aria-hidden={hidden} />
    </>
  );
}

export function PoweredByStx({ compact = false }: { compact?: boolean }) {
  return (
    <a
      className={`powered-by${compact ? " powered-by-compact" : ""}`}
      href={stxUrl()}
      target="_blank"
      rel="noreferrer"
      title="Powered by the STX Exchange"
    >
      <span className="powered-by-text">Powered by</span>
      <Themed light={stxLogoLight} dark={stxLogoDark} alt="STX" className="powered-by-logo" />
    </a>
  );
}

// The STX mark: the X of the STX logo. Pass alt="STX" where it names STX; the
// default is decorative.
export function StxMark({ alt = "", className = "" }: { alt?: string; className?: string }) {
  return <Themed light={stxMarkLight} dark={stxMarkDark} alt={alt} className={`stx-mark ${className}`.trim()} />;
}

// The full STX logo inline with text, e.g. "Live from [STX]".
export function StxLogo({ className = "" }: { className?: string }) {
  return <Themed light={stxLogoLight} dark={stxLogoDark} alt="STX" className={className} />;
}
