import { NavLink } from "react-router-dom";
import type { Permission } from "@patchpilot/shared";
import { useEngineer } from "../lib/auth";
import { useBranding, PRODUCT_NAME, DEFAULT_LOGO_URL } from "../lib/branding";

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

// Information architecture ported directly from the M365 prototype sidebar.
const GROUPS: NavGroup[] = [
  {
    heading: "Operations",
    items: [
      { label: "Dashboard", to: "/" },
      { label: "Vulnerabilities", to: "/vulnerabilities" },
      { label: "Security Recommendations", to: "/recommendations" },
      { label: "Devices", to: "/devices" },
      { label: "Device Groups", to: "/device-groups" },
      { label: "Windows Updates", to: "/windows-updates" },
      { label: "Schedules", to: "/schedules" },
      { label: "Jobs", to: "/jobs" },
      { label: "Inventories", to: "/software-inventory" },
      // An operational record read alongside Jobs during an incident, not configuration.
      { label: "Audit Log", to: "/audit" },
      // The attributed ledger behind the dashboard's time-to-remediate metric.
      { label: "Remediation History", to: "/remediation-history" },
      { label: "Reports", to: "/reports", permission: "operations:read" },
    ],
  },
  {
    heading: "Catalog",
    items: [
      { label: "Winget Catalog", to: "/catalog" },
      { label: "Chocolatey Catalog", to: "/catalog/chocolatey" },
      { label: "Script Catalog", to: "/catalog/scripts" },
    ],
  },
  {
    heading: "Setup",
    items: [
      { label: "Setup Health", to: "/setup/health" },
      { label: "App Registration", to: "/setup/app-registration" },
      { label: "Architecture", to: "/setup/architecture" },
    ],
  },
  {
    heading: "Settings",
    items: [
      { label: "Branding", to: "/settings/branding" },
      { label: "Compliance SLA", to: "/settings/sla" },
      { label: "Notifications", to: "/settings/notifications" },
      { label: "Target Build", to: "/settings/feature-updates" },
      { label: "Tenants", to: "/settings/tenants" },
      { label: "License", to: "/settings/license" },
      { label: "Updates", to: "/settings/updates" },
      { label: "Users", to: "/settings/users", permission: "users:manage" },
    ],
  },
];

export function Sidebar() {
  const { permissions } = useEngineer();
  const can = (permission: Permission) => permissions.includes(permission);
  const { data: branding } = useBranding();
  return (
    <aside className="flex h-screen w-64 shrink-0 flex-col bg-[#0b1020] text-slate-300 print:hidden">
      <div className="flex items-center gap-2 px-5 py-5">
        <img
          src={branding?.logoUrl || DEFAULT_LOGO_URL}
          alt={PRODUCT_NAME}
          className="h-8 w-8 shrink-0 rounded-lg object-contain"
        />
        <span className="text-base font-semibold text-white">{PRODUCT_NAME}</span>
      </div>

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
                      ? "bg-indigo-600/90 text-white"
                      : "text-slate-300 hover:bg-white/5 hover:text-white",
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
          className={({ isActive }) =>
            [
              "block rounded-md px-3 py-2 text-sm transition-colors",
              isActive
                ? "bg-indigo-600/90 text-white"
                : "text-slate-300 hover:bg-white/5 hover:text-white",
            ].join(" ")
          }
        >
          Help
        </NavLink>
      </div>
    </aside>
  );
}
