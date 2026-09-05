// Per-engineer light/dark preference (Settings has none for this — it's
// personal, not tenant-wide, so it lives on the engineer's own row via
// PATCH /auth/me/theme, not in @patchpilot/db's `settings` table).
//
// Initialized from the authenticated engineer (GET /auth/me), applied as a
// `dark` class on <html> (see index.css's `@custom-variant dark`), and kept
// in sync with the server so the preference follows an engineer across
// devices/browsers rather than living only in this one's localStorage.

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { useEngineer } from "./auth";

export type Theme = "light" | "dark";

interface ThemeContextValue {
  theme: Theme;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

/** Must render inside <AuthGate> — it reads the signed-in engineer's stored
 *  preference as the initial value. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const engineer = useEngineer();
  const qc = useQueryClient();
  const [theme, setTheme] = useState<Theme>(engineer.theme);

  // Runs on mount and on every toggle — not just mount — so a change made in
  // another tab of the same session (both reading the same initial
  // engineer.theme) still repaints this one after its own toggle.
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const persist = useMutation({
    mutationFn: (next: Theme) => api.patch<{ theme: Theme }>("/auth/me/theme", { theme: next }),
  });

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    persist.mutate(next);
    // Keep the cached /auth/me identity consistent so a remount before the
    // next real auth fetch (e.g. a route change re-reading useEngineer)
    // doesn't momentarily flash back to the old value.
    qc.setQueryData(["auth", "me"], (prev: unknown) => {
      if (!prev || typeof prev !== "object" || !("engineer" in prev)) return prev;
      const data = prev as { engineer?: { theme: Theme } };
      if (!data.engineer) return prev;
      return { ...data, engineer: { ...data.engineer, theme: next } };
    });
  }

  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used inside <ThemeProvider>");
  }
  return ctx;
}

/** Crescent-moon toggle for the top bar — see App.tsx's EngineerMenu. */
export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const isDark = theme === "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      aria-pressed={isDark}
      className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-300"
    >
      <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden>
        <path
          fillRule="evenodd"
          d="M9.528 1.718a.75.75 0 0 1 .162.819A8.97 8.97 0 0 0 9 6a9 9 0 0 0 9 9 8.97 8.97 0 0 0 3.463-.69.75.75 0 0 1 .981.98 10.503 10.503 0 0 1-9.694 6.46c-5.799 0-10.5-4.701-10.5-10.5 0-4.368 2.667-8.112 6.46-9.694a.75.75 0 0 1 .818.162Z"
          clipRule="evenodd"
        />
      </svg>
    </button>
  );
}
