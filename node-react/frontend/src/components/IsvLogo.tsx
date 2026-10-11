// The app's own logo in the top bar: the pennant it registers with STX as its
// logo (public/assets/brand/sideline-mark.svg, shown on STX's sign-in, consent
// and Connected Apps screens) and the wordmark. The mark is drawn inline and the name is live text in the wordmark
// face, so both follow the theme: the pennant's pole and the wordmark take the
// text colour and the flag keeps the brand blue. Another app id gets a letter
// tile in its brand colour.
function SidelineMark() {
  return (
    <svg className="isv-logo-mark" viewBox="0 0 40 40" aria-hidden="true" focusable="false">
      <rect x="7" y="4" width="3.2" height="32" rx="1.6" fill="currentColor" />
      <path d="M10.2 6 L34 13.5 L10.2 21 Z" fill="#3d8bff" />
    </svg>
  );
}

// Playbook: its registered icon (public/assets/brand/playbook-icon.svg, the same
// file STX shows on its sign-in and consent screens), so a new icon is a one-file swap.
function PlaybookMark() {
  return <img className="isv-logo-mark" src="/assets/brand/playbook-icon.svg" alt="" aria-hidden="true" />;
}

const MARKS: Record<string, () => JSX.Element> = {
  sideline: SidelineMark,
  playbook: PlaybookMark,
};

export function IsvLogo({ appId, name, brandColor }: { appId?: string; name: string; brandColor: string }) {
  const Mark = appId ? MARKS[appId] : undefined;
  return (
    <span className="isv-logo">
      {Mark ? (
        <Mark />
      ) : (
        <span className="isv-mark" style={{ background: brandColor }} aria-hidden="true">
          {(name[0] || "?").toUpperCase()}
        </span>
      )}
      <span className="isv-name">{name}</span>
      {/* Sideline is a sample app, said on every page so nobody takes it for a real product. */}
      <span className="demo-badge">Demo app</span>
    </span>
  );
}
