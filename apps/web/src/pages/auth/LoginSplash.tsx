import { useBranding, DEFAULT_LOGO_URL, PRODUCT_NAME } from "../../lib/branding";

/**
 * Shown by <AuthGate> whenever there is no active session on an
 * already-paired instance (401 from /auth/me, or an explicit
 * { authenticated: false } body). Replaces the old instant
 * `window.location.href = "/auth/login"` redirect: the browser now waits
 * here until the engineer clicks the button, which is the only thing that
 * starts the OIDC redirect. See lib/auth.tsx's useLogout()/AuthGate.
 *
 * Only ever rendered once AuthGate's entraConfigured check has already
 * passed — an unpaired instance shows <SetupPairing /> instead, checked
 * first — so this screen never needs to gate on pairing itself.
 */
export function LoginSplash() {
  const { data: branding } = useBranding();

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-6 py-10 dark:bg-slate-950">
      <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <img
          src={branding?.logoUrl || DEFAULT_LOGO_URL}
          alt={PRODUCT_NAME}
          className="mx-auto h-20 w-20 rounded-2xl object-contain"
        />
        <h1 className="mt-4 text-lg font-semibold text-slate-900 dark:text-white">
          {PRODUCT_NAME}
        </h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Sign in to continue
        </p>

        <button
          type="button"
          onClick={() => {
            window.location.href = "/auth/login";
          }}
          className="mt-6 inline-flex w-full items-center justify-center gap-3 rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
        >
          <MicrosoftLogo />
          Sign in with Microsoft 365
        </button>
      </div>
    </div>
  );
}

/** Official 4-color Microsoft squares mark, per the identity-platform
 *  "Sign in with Microsoft" branding guidelines. Inline SVG — no asset
 *  fetch, no network dependency on the login screen itself. */
function MicrosoftLogo() {
  return (
    <svg viewBox="0 0 21 21" className="h-4 w-4 shrink-0" aria-hidden>
      <rect x="1" y="1" width="9" height="9" fill="#F25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
      <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  );
}
