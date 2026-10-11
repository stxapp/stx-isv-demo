import { track } from "../../analytics";
import { BACKEND, openStxPopup, type PublicApp } from "../../api";
import { POPUP_MIN_WIDTH } from "../stx/signIn";

// Login mode `vendor`: the app's login is a login service. One button sends
// the person to the service's own login page, which lists STX among its
// options. After they log in there, the backend signs them in to the app and,
// if they have no STX link yet, sends them straight on to link their STX
// account.

export function vendorStartUrl(backend = ""): string {
  return `${backend}/auth/vendor/start`;
}

function start() {
  track("sign_in_start", { connection: "vendor" });
  const url = vendorStartUrl(BACKEND);
  if (window.innerWidth >= POPUP_MIN_WIDTH && openStxPopup(url, "vendor_sign_in", { w: 480, h: 760 })) return;
  window.location.assign(url);
}

export function VendorSignIn({ app, vendorName }: { app: PublicApp; vendorName: string }) {
  return (
    <div className="card signin">
      <h3>Sign in to {app.name}</h3>
      <div className="signin-buttons">
        <button type="button" id="signin-vendor" className="primary" onClick={start}>
          Continue with {vendorName}
        </button>
      </div>
      <p className="muted">
        {app.name} uses {vendorName} for its login. Choose STX there to log in with your STX account, then allow{" "}
        {app.name} to trade for you.
      </p>
      <p className="fiction-note">
        {app.name} is a fictional sports app used to demonstrate building on STX. It is not a real product or
        company.
      </p>
    </div>
  );
}
