import { NavLink } from "react-router-dom";
import type { Permission } from "@patchpilot/shared";
import { useEngineer } from "../lib/auth";
import { useBranding, PRODUCT_NAME, DEFAULT_LOGO_URL } from "../lib/branding";
import { useSidebarUi } from "../lib/sidebarUi";

interface NavItem {
  label: string;
  to: string;
  // Omitted for items every role can see — only Settings > Users needs one today.
  permission?: Permission;
}

interface NavGroup {
  heading: string;
  items: NavItem[];
}

// Information architecture ported directly from the M365 prototype sidebar,
// then split so Operations' backward-looking record pages (Reports,
// Remediation History, Audit Log, Inventories) have their own "Reports &
// Records" group instead of crowding the live/actionable Operations list.
// Dashboard is pinned first in Operations (it's the "/" landing page);
// every other item within every group is strictly alphabetical by label.
const GROUPS: NavGroup[] = [
  {
    heading: "Operations",
    items: [
      { label: "Dashboard", to: "/" },
      { label: "Device Groups", to: "/device-groups" },
      { label: "Devices", to: "/devices" },
      { label: "Jobs", to: "/jobs" },
      { label: "Schedules", to: "/schedules" },
      { label: "Security Recommendations", to: "/recommendations" },
      { label: "Vulnerabilities", to: "/vulnerabilities" },
      { label: "Windows Updates", to: "/windows-updates" },
    ],
  },
  {
    heading: "Reports & Records",
    items: [
      // An operational record read alongside Jobs during an incident, not configuration.
      { label: "Audit Log", to: "/audit" },
      { label: "Inventories", to: "/software-inventory" },
      // The attributed ledger behind the dashboard's time-to-remediate metric.
      { label: "Remediation History", to: "/remediation-history" },
      { label: "Reports", to: "/reports", permission: "operations:read" },
    ],
  },
  {
    heading: "Catalog",
    items: [
      { label: "Chocolatey Catalog", to: "/catalog/chocolatey" },
      { label: "Script Catalog", to: "/catalog/scripts" },
      { label: "Winget Catalog", to: "/catalog" },
    ],
  },
  {
    heading: "Setup",
    items: [
      { label: "App Registration", to: "/setup/app-registration" },
      { label: "Architecture", to: "/setup/architecture" },
      { label: "Setup Health", to: "/setup/health" },
    ],
  },
  {
    heading: "Settings",
    items: [
      { label: "Branding", to: "/settings/branding" },
      { label: "Compliance SLA", to: "/settings/sla" },
      { label: "License", to: "/settings/license" },
      { label: "Notifications", to: "/settings/notifications" },
      { label: "Target Build", to: "/settings/feature-updates" },
      { label: "Tenants", to: "/settings/tenants" },
      { label: "Updates", to: "/settings/updates" },
      { label: "Users", to: "/settings/users", permission: "users:manage" },
    ],
  },
];

/**
 * The nav content itself — logo-free, width-free. Shared by the desktop
 * `Sidebar` (expanded state) and `MobileSidebarDrawer`, so both stay in sync
 * with one implementation. `onNavigate` is an optional extra close-on-click
 * hook for the mobile drawer (redundant with its own route-change effect,
 * but harmless and a bit snappier).
 */
export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const { permissions } = useEngineer();
  const can = (permission: Permission) => permissions.includes(permission);

  return (
    <>
      <nav className="flex-1 overflow-y-auto px-3 pb-6">
        {GROUPS.map((group) => (
          <div key={group.heading} className="mb-5">
            <div className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              {group.heading}
            </div>
            {group.items
              .filter((item) => !item.permission || can(item.permission))
              .map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={onNavigate}
                end={
                  item.to === "/" ||
                  // Exact-match any route that is itself a path prefix of a sibling
                  // route (e.g. "/catalog" vs "/catalog/chocolatey"), otherwise
                  // NavLink's default prefix matching highlights both at once.
                  group.items.some(
                    (other) => other !== item && other.to.startsWith(`${item.to}/`)
                  )
                }
                className={({ isActive }) =>
                  [
                    "block rounded-md px-3 py-2 text-sm transition-colors",
                    isActive
                      ? "bg-[var(--pp-primary)]/90 text-white"
                      : "text-slate-300 hover:bg-[var(--pp-secondary)]/10 hover:text-white",
                  ].join(" ")
                }
              >
                {item.label}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      <div className="border-t border-white/10 px-3 py-3">
        <NavLink
          to="/help"
          onClick={onNavigate}
          className={({ isActive }) =>
            [
              "block rounded-md px-3 py-2 text-sm transition-colors",
              isActive
                ? "bg-[var(--pp-primary)]/90 text-white"
                : "text-slate-300 hover:bg-[var(--pp-secondary)]/10 hover:text-white",
            ].join(" ")
          }
        >
          Help
        </NavLink>
      </div>
    </>
  );
}

function ChevronLeftIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden>
      <path
        fillRule="evenodd"
        d="M12.79 5.23a.75.75 0 0 1 0 1.06L9.06 10l3.73 3.71a.75.75 0 1 1-1.06 1.06l-4.25-4.25a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden>
      <path
        fillRule="evenodd"
        d="M7.21 14.77a.75.75 0 0 1 0-1.06L10.94 10 7.21 6.29a.75.75 0 1 1 1.06-1.06l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

/** Desktop-only sidebar — hidden below `lg`, where `MobileSidebarDrawer`
 *  takes over instead. Collapses to a thin strip (no per-item icons, no
 *  rail — just an expand button) rather than an icon-only rail, since the
 *  app has no icon library and per-item icons would be a much bigger,
 *  separate addition. */
export function Sidebar() {
  const { data: branding } = useBranding();
  const { collapsed, toggleCollapsed } = useSidebarUi();

  if (collapsed) {
    return (
      <aside className="hidden h-screen w-6 shrink-0 flex-col items-center bg-[var(--pp-bg)] py-5 print:hidden lg:flex">
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label="Expand sidebar"
          title="Expand sidebar"
          className="rounded-md p-1 text-slate-400 transition-colors hover:bg-white/5 hover:text-white"
        >
          <ChevronRightIcon />
        </button>
      </aside>
    );
  }

  return (
    <aside className="hidden h-screen w-64 shrink-0 flex-col bg-[var(--pp-bg)] text-slate-300 print:hidden lg:flex">
      <div className="flex items-center gap-2 px-5 py-5">
        <img
          src={branding?.logoUrl || DEFAULT_LOGO_URL}
          alt={PRODUCT_NAME}
          className="h-8 w-8 shrink-0 rounded-lg object-contain"
        />
        <span className="flex-1 truncate text-base font-semibold text-white">{PRODUCT_NAME}</span>
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label="Collapse sidebar"
          title="Collapse sidebar"
          className="shrink-0 rounded-md p-1 text-slate-400 transition-colors hover:bg-white/5 hover:text-white"
        >
          <ChevronLeftIcon />
        </button>
      </div>

      <SidebarNav />
    </aside>
  );
}
