import { useEffect } from "react";
import { useBranding, PRODUCT_NAME, DEFAULT_LOGO_URL } from "../lib/branding";
import { useSidebarUi } from "../lib/sidebarUi";
import { SidebarNav } from "./Sidebar";

/**
 * Left-sliding overlay standing in for the full Sidebar below `lg`, where
 * `Sidebar` itself renders nothing (`hidden lg:flex`). Mirrors ui.tsx's
 * `SlideOver` pattern (fixed inset-0 backdrop + Esc-key listener) but
 * hand-styled to match the sidebar's dark chrome and anchored left instead
 * of right — `SlideOver`'s white/titled/right-anchored panel doesn't fit a
 * nav drawer with no title bar.
 */
export function MobileSidebarDrawer() {
  const { data: branding } = useBranding();
  const { mobileOpen, closeMobile } = useSidebarUi();

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMobile();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen, closeMobile]);

  if (!mobileOpen) return null;

  return (
    <div className="fixed inset-0 z-40 flex lg:hidden print:hidden">
      <div className="absolute inset-0 bg-slate-900/30" onClick={closeMobile} aria-hidden />
      <aside className="relative z-10 flex h-full w-72 max-w-[85vw] flex-col overflow-y-auto bg-[#0b1020] text-slate-300 shadow-xl">
        <div className="flex items-center gap-2 px-5 py-5">
          <img
            src={branding?.logoUrl || DEFAULT_LOGO_URL}
            alt={PRODUCT_NAME}
            className="h-8 w-8 shrink-0 rounded-lg object-contain"
          />
          <span className="truncate text-base font-semibold text-white">{PRODUCT_NAME}</span>
        </div>
        <SidebarNav onNavigate={closeMobile} />
      </aside>
    </div>
  );
}
