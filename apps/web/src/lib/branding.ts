import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import defaultLogo from "../assets/logo.png";

/**
 * The product name is fixed — see PRODUCT_NAME below for why — so this is
 * only the shape of the *customizable* parts of branding (colours + logo).
 * Kept in one place so Sidebar and the Branding settings page can't drift.
 */
export interface Branding {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  /** null/absent = use the bundled default logo (assets/logo.png). */
  logoUrl: string | null;
}

export const BRANDING_DEFAULTS: Branding = {
  primary: "#4f46e5",
  secondary: "#0ea5e9",
  accent: "#f59e0b",
  background: "#0b1020",
  logoUrl: null,
};

// Locked, not an editable setting: the API enforces this same value server-side
// on every PUT /api/settings/branding (see routes/data.ts), so a crafted
// request can't rename the product either. If white-labelling ever becomes a
// real requirement, that's a deliberate product decision to unlock both sides
// together — not something to quietly drop out of one file.
export const PRODUCT_NAME = "PatchPilot365";

export const DEFAULT_LOGO_URL = defaultLogo;

/** Shared by Sidebar (read-only chrome) and the Branding settings page (editable form). */
export function useBranding() {
  return useQuery({
    queryKey: ["settings", "branding"],
    // 404 is fine for a never-set key; fall back to defaults.
    queryFn: async () => {
      try {
        return await api.get<Partial<Branding>>("/api/settings/branding");
      } catch {
        return BRANDING_DEFAULTS;
      }
    },
    staleTime: 60_000,
  });
}
