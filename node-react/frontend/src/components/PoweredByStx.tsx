// "Powered by STX" attribution. The official STX color logo (kept in the repo at
// src/assets/stx-logo.png) links out to the STX exchange — the host that provides
// the OAuth and runs the markets. Imported (not from /public) so Vite emits it
// under /assets, which the public preview WAF allows.
import stxLogo from "../assets/stx-logo.png";
import { STX_HTTP_URL } from "../publicMarketData";

export function PoweredByStx({ compact = false }: { compact?: boolean }) {
  return (
    <a
      className={`powered-by${compact ? " powered-by-compact" : ""}`}
      href={STX_HTTP_URL}
      target="_blank"
      rel="noreferrer"
      title="Powered by the STX Exchange"
    >
      <span className="powered-by-text">Powered by</span>
      <img src={stxLogo} alt="STX" className="powered-by-logo" />
    </a>
  );
}
