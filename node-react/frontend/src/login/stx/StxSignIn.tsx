import { track } from "../../analytics";
import { BACKEND, openStxPopup, type PublicApp } from "../../api";
import { StxLogo } from "../../components/PoweredByStx";
import { PROVIDERS } from "./providers";
import { type Connection, startSignIn } from "./signIn";

// Login mode `stx`: the app has no login of its own. The first button opens
// STX's own page, where the person logs in with email and password or
// registers. "Continue with Google / Apple / X" are shortcuts through STX
// (`connection=google|apple|x`) straight to that provider. A new member finishes
// STX's one-time onboarding (details, identity checks, terms) and allows the
// app; an existing member just allows it. The backend keeps the STX tokens and
// gives this browser only a session cookie.

function continueWith(connection?: Connection) {
  track("sign_in_start", { connection: connection ?? "stx" });
  startSignIn(
    connection,
    {
      width: window.innerWidth,
      openPopup: (url) => openStxPopup(url, "stx_sign_in", { w: 480, h: 760 }),
      navigate: (url) => window.location.assign(url),
    },
    BACKEND,
  );
}

export function StxSignIn({ app }: { app: PublicApp }) {
  return (
    <div className="card signin">
      <h3>Sign in to {app.name}</h3>
      <div className="signin-buttons">
        <button type="button" id="signin-stx" className="link-cta signin-stx" onClick={() => continueWith()}>
          <StxLogo alt="" className="link-cta-logo" />
          <span>Continue with your STX account</span>
        </button>
        {PROVIDERS.map((p) => (
          <button
            key={p.connection}
            type="button"
            id={`signin-${p.connection}`}
            className={`signin-provider ${p.connection}`}
            onClick={() => continueWith(p.connection)}
          >
            <img src={p.logo} alt="" aria-hidden="true" />
            {p.label}
          </button>
        ))}
      </div>
      <p className="muted">
        New to STX? You'll set up your STX account and verify your identity once, then allow {app.name}.
        Already an STX member? Just allow {app.name}.
      </p>
      <p className="fiction-note">
        {app.name} is a fictional sports app used to demonstrate building on STX. It is not a real product or
        company.
      </p>
    </div>
  );
}
