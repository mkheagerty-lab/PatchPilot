// Desktop collapse (persisted) and mobile drawer (ephemeral) state for the
// Sidebar. Deliberately localStorage, not server-side, unlike theme.tsx's
// engineer-level preference — this is browser-local UI chrome, not a
// cross-device identity attribute (see lib/theme.tsx's header comment on why
// *that* preference follows the engineer instead).

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";

const COLLAPSED_KEY = "pp:sidebar-collapsed";

interface SidebarUiContextValue {
  collapsed: boolean;
  toggleCollapsed: () => void;
  mobileOpen: boolean;
  openMobile: () => void;
  closeMobile: () => void;
}

const SidebarUiContext = createContext<SidebarUiContextValue | null>(null);

export function SidebarUiProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  // Close the drawer on route change — a nav click should always land on the
  // page, not leave the overlay open behind it.
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSED_KEY, String(next));
      } catch {
        // Best-effort — worst case it re-expands next load.
      }
      return next;
    });
  }

  return (
    <SidebarUiContext.Provider
      value={{
        collapsed,
        toggleCollapsed,
        mobileOpen,
        openMobile: () => setMobileOpen(true),
        closeMobile: () => setMobileOpen(false),
      }}
    >
      {children}
    </SidebarUiContext.Provider>
  );
}

export function useSidebarUi(): SidebarUiContextValue {
  const ctx = useContext(SidebarUiContext);
  if (!ctx) {
    throw new Error("useSidebarUi must be used within SidebarUiProvider");
  }
  return ctx;
}
