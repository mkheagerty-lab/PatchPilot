// Client-side auth gate. The browser holds only a session cookie; it never sees
// a token. On load we ask the API who we are (`GET /auth/me`); a 401 means no
// session, so we hand the browser to the API's `/auth/login` route, which starts
// the OIDC redirect to Microsoft. In DEMO_MODE the API injects a demo engineer,
// so /auth/me succeeds and the gate is transparent.

import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Permission, Role } from "@patchpilot/shared";
import { api, ApiError, setCsrfToken } from "./api";
import { SetupPairing } from "../pages/setup/SetupPairing";

export interface Engineer {
  upn: string;
  displayName: string;
  homeTenantId: string;
  role: Role;
  permissions: Permission[];
}

interface MeResponse {
  authenticated: boolean;
  entraConfigured?: boolean;
  engineer?: Engineer;
  csrfToken?: string;
}

// Exported so tests can render components inside <AuthContext.Provider value={fakeEngineer}>
// to inject an arbitrary role/permission set without mocking the full /auth/me fetch.
export const AuthContext = createContext<Engineer | null>(null);

/** The signed-in engineer. Only valid inside <AuthGate>. */
export function useEngineer(): Engineer {
  const engineer = useContext(AuthContext);
  if (!engineer) {
    throw new Error("useEngineer must be used inside an authenticated <AuthGate>");
  }
  return engineer;
}

/** Whether the signed-in engineer holds `permission`. Only valid inside <AuthGate>. */
export function useCan(permission: Permission): boolean {
  const engineer = useEngineer();
  return engineer.permissions.includes(permission);
}

/** Best-effort server logout, then restart the login flow. */
export function logout(): void {
  void api
    .post("/auth/logout", {})
    .catch(() => undefined)
    .finally(() => {
      window.location.href = "/auth/login";
    });
}

function FullScreen({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen items-center justify-center bg-slate-50">
      <div className="text-sm text-slate-500">{children}</div>
    </div>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => api.get<MeResponse>("/auth/me"),
    retry: false,
    staleTime: 5 * 60_000,
  });

  // Piggybacks on the boot-time /auth/me call rather than a separate
  // request: this fires before any mutating UI (rendered below, once
  // authenticated) is reachable.
  useEffect(() => {
    setCsrfToken(data?.csrfToken);
  }, [data?.csrfToken]);

  if (isLoading) {
    return <FullScreen>Checking your session…</FullScreen>;
  }

  // A never-paired instance has no Entra app registration to sign in against —
  // /auth/login would just bounce to a Microsoft error page. Show the pairing
  // setup screen instead of redirecting; it recovers on its own once pairing
  // completes (see SetupPairing's polling). This check must come before the
  // unauthenticated redirect below, since an unpaired instance is always also
  // unauthenticated — /auth/me 401s (no session), so the flag rides the
  // ApiError's parsed body (error.data), not the react-query `data` field,
  // which stays undefined on a thrown request.
  const entraConfigured =
    data?.entraConfigured ??
    (error instanceof ApiError && error.data && typeof error.data === "object"
      ? (error.data as { entraConfigured?: boolean }).entraConfigured
      : undefined);
  if (entraConfigured === false) {
    return <SetupPairing />;
  }

  // No session (401) or an explicit not-authenticated body → start login. The API
  // redirects the browser to Microsoft; silent SSO completes it when possible.
  const unauthenticated =
    (isError && error instanceof ApiError && error.status === 401) ||
    (data != null && !data.authenticated);
  if (unauthenticated) {
    window.location.href = "/auth/login";
    return <FullScreen>Redirecting to sign in…</FullScreen>;
  }

  // Any other error means the API itself is unreachable — surface it instead of
  // bouncing into a redirect loop.
  if (isError || !data?.engineer) {
    return (
      <FullScreen>
        Couldn&apos;t reach the PatchPilot API. Check that it&apos;s running, then
        reload.
      </FullScreen>
    );
  }

  return <AuthContext.Provider value={data.engineer}>{children}</AuthContext.Provider>;
}
