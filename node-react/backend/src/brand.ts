// The built page (frontend/index.html) is written for the default app,
// Sideline. One image serves any app: when the page is served, its origin, the
// app's name and the app's icons are filled in from this deployment's settings
// (PUBLIC_URL, APP_ID, APP_NAME).

export interface Brand {
  // This deployment's public origin, for the share card's absolute URLs.
  origin: string;
  appId: string;
  appName: string;
  // public/assets/brand/<appId>-icon.svg exists.
  hasIcon: boolean;
  // public/assets/brand/<appId>/ holds favicon-32.png, apple-touch-icon.png and og-image.png.
  hasImages: boolean;
}

export function brandIndexHtml(html: string, brand: Brand): string {
  let out = html.replaceAll("__PUBLIC_URL__", brand.origin);
  if (brand.appId !== "sideline" && brand.hasIcon) out = out.replaceAll("/assets/brand/sideline-icon.svg", `/assets/brand/${brand.appId}-icon.svg`);
  if (brand.appId !== "sideline" && brand.hasImages) {
    for (const file of ["favicon-32.png", "apple-touch-icon.png", "og-image.png"]) {
      out = out.replaceAll(`/assets/brand/${file}`, `/assets/brand/${brand.appId}/${file}`);
    }
  }
  // The name appears only as text in the page head; it is escaped for HTML.
  return out.replaceAll("Sideline", escapeHtml(brand.appName));
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
