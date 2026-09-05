import type { ReactNode } from "react";
import { Routes, Route, Outlet, Navigate } from "react-router-dom";
import type { Permission } from "@patchpilot/shared";
import { Sidebar } from "./components/Sidebar";
import { TenantSwitcher } from "./components/TenantSwitcher";
import { TenantProvider } from "./lib/tenant";
import { AuthGate, useEngineer, useCan, useLogout } from "./lib/auth";
import { ThemeProvider, ThemeToggle } from "./lib/theme";
import { PageHeader, Placeholder } from "./components/ui";
import { Dashboard } from "./pages/dashboard/Dashboard";
import { Vulnerabilities } from "./pages/Vulnerabilities";
import { Recommendations } from "./pages/Recommendations";
import { Devices } from "./pages/Devices";
import { Branding } from "./pages/settings/Branding";
import { Sla } from "./pages/settings/Sla";
import { Notifications } from "./pages/settings/Notifications";
import { FeatureUpdates } from "./pages/settings/FeatureUpdates";
import { Tenants } from "./pages/settings/Tenants";
import { License } from "./pages/settings/License";
import { Updates } from "./pages/settings/Updates";
import { SetupHealth } from "./pages/setup/SetupHealth";
import { AppRegistration } from "./pages/setup/AppRegistration";
import { ArchitecturePage } from "./pages/setup/architecture/ArchitecturePage";
import { Catalog } from "./pages/Catalog";
import { ChocolateyCatalog } from "./pages/ChocolateyCatalog";
import { ScriptCatalog } from "./pages/ScriptCatalog";
import { Schedules } from "./pages/Schedules";
import { DeviceGroups } from "./pages/DeviceGroups";
import { WindowsUpdates } from "./pages/WindowsUpdates";
import { Jobs } from "./pages/Jobs";
import { SoftwareInventory } from "./pages/SoftwareInventory";
import { AuditLog } from "./pages/AuditLog";
import { RemediationHistory } from "./pages/RemediationHistory";
import { Users } from "./pages/settings/Users";
import { Reports } from "./pages/Reports";
import { Help } from "./pages/Help";
import { ChatWidget } from "./components/ai/ChatWidget";
import { UpdateAvailableBanner } from "./components/UpdateAvailableBanner";

function EngineerMenu() {
  const engineer = useEngineer();
  const logout = useLogout();
  return (
    <div className="flex items-center gap-3 text-sm">
      <ThemeToggle />
      <div className="text-right">
        <div className="font-medium text-slate-700 dark:text-slate-200">{engineer.displayName}</div>
        <div className="text-xs text-slate-400">{engineer.upn}</div>
      </div>
      <button
        type="button"
        onClick={logout}
        className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
      >
        Sign out
      </button>
    </div>
  );
}

// Fails closed on a hand-typed URL, not just a hidden nav link — the server-side
// `requirePermission` guard is the real boundary (see packages/shared/src/rbac.ts),
// this just keeps the SPA from rendering a page the API will refuse anyway.
function RequirePermission({
  permission,
  children,
}: {
  permission: Permission;
  children: ReactNode;
}) {
  const allowed = useCan(permission);
  if (!allowed) {
    return (
      <div>
        <PageHeader title="Users" />
        <Placeholder note="You don't have access to this page." />
      </div>
    );
  }
  return <>{children}</>;
}

function Layout() {
  const canUseAi = useCan("ai:use");
  return (
    <ThemeProvider>
      <div className="flex">
        <Sidebar />
        <div className="flex h-screen flex-1 flex-col overflow-hidden print:h-auto print:overflow-visible">
          <header className="flex h-16 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-8 print:hidden dark:border-slate-800 dark:bg-slate-900">
            <TenantSwitcher />
            <EngineerMenu />
          </header>
          <UpdateAvailableBanner />
          <main className="flex-1 overflow-y-auto bg-slate-50 px-8 py-7 print:h-auto print:overflow-visible dark:bg-slate-950">
            <Outlet />
          </main>
        </div>
        {canUseAi && <ChatWidget />}
      </div>
    </ThemeProvider>
  );
}

export default function App() {
  return (
    <AuthGate>
      <TenantProvider>
        <Routes>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="vulnerabilities" element={<Vulnerabilities />} />
          <Route path="recommendations" element={<Recommendations />} />
          <Route path="devices" element={<Devices />} />
          <Route path="device-groups" element={<DeviceGroups />} />
          <Route path="windows-updates" element={<WindowsUpdates />} />
          <Route
            path="feature-update-campaigns"
            element={<Navigate to="/windows-updates" replace />}
          />
          <Route path="schedules" element={<Schedules />} />
          <Route path="jobs" element={<Jobs />} />
          <Route path="software-inventory" element={<SoftwareInventory />} />
          <Route path="audit" element={<AuditLog />} />
          <Route path="remediation-history" element={<RemediationHistory />} />
          <Route path="reports" element={<Reports />} />
          <Route path="catalog" element={<Catalog />} />
          <Route path="catalog/chocolatey" element={<ChocolateyCatalog />} />
          <Route path="catalog/scripts" element={<ScriptCatalog />} />
          <Route path="setup/health" element={<SetupHealth />} />
          <Route
            path="setup/connections"
            element={<Navigate to="/setup/health?tab=connections" replace />}
          />
          <Route
            path="setup/readiness"
            element={<Navigate to="/setup/health?tab=readiness" replace />}
          />
          <Route
            path="setup/preflight"
            element={<Navigate to="/setup/health?tab=preflight" replace />}
          />
          <Route
            path="setup/app-registration"
            element={<AppRegistration />}
          />
          <Route path="setup/architecture" element={<ArchitecturePage />} />
          <Route path="settings/branding" element={<Branding />} />
          <Route path="settings/sla" element={<Sla />} />
          <Route path="settings/notifications" element={<Notifications />} />
          <Route path="settings/feature-updates" element={<FeatureUpdates />} />
          <Route path="settings/tenants" element={<Tenants />} />
          <Route path="settings/license" element={<License />} />
          <Route path="settings/updates" element={<Updates />} />
          <Route path="help" element={<Help />} />
          <Route
            path="settings/users"
            element={
              <RequirePermission permission="users:manage">
                <Users />
              </RequirePermission>
            }
          />
        </Route>
        </Routes>
      </TenantProvider>
    </AuthGate>
  );
}
