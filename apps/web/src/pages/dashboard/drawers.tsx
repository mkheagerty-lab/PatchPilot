// The Dashboard's two SlideOver drawers. Both fetch lazily (only once opened)
// under the same query key the full list pages use (`["vulnerabilities", …]`
// / `["devices", …]`) — if the engineer already visited that page this
// session, the drawer opens instantly from cache; otherwise it fires one
// full-list fetch on first open only. The default dashboard load never pays
// for either.
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, type Device, type Vulnerability } from "../../lib/api";
import { useTenant } from "../../lib/tenant";
import { SlideOver, DetailRow, ComplianceChip } from "../../components/ui";
import { CveDetailBody } from "../../components/cve";
import { toDevice, toVulnerabilities } from "./links";

export function VulnDrawer({ vulnId, onClose }: { vulnId: string | null; onClose: () => void }) {
  const { activeTenantId, isAllTenants, tenants } = useTenant();

  const { data: vulns } = useQuery({
    queryKey: ["vulnerabilities", activeTenantId],
    queryFn: () =>
      api.get<Vulnerability[]>(
        isAllTenants ? "/api/vulnerabilities" : `/api/vulnerabilities?tenantId=${activeTenantId}`,
      ),
    enabled: vulnId !== null && !!activeTenantId,
  });

  const vuln = vulns?.find((v) => v.id === vulnId) ?? null;
  const tenantNames = new Map(tenants.map((t) => [t.tenantId, t.displayName]));

  return (
    <SlideOver open={vulnId !== null} onClose={onClose} title={vuln?.cveId ?? ""} subtitle="Vulnerability">
      {vulnId && !vuln ? (
        <div className="py-8 text-center text-sm text-slate-400">Loading…</div>
      ) : vuln ? (
        <div className="space-y-4">
          <CveDetailBody
            vuln={vuln}
            tenantLabel={isAllTenants ? (tenantNames.get(vuln.tenantId) ?? vuln.tenantId) : null}
          />
          <Link
            to={toVulnerabilities()}
            className="block text-center text-xs font-medium text-indigo-600 hover:text-indigo-700"
          >
            View full detail →
          </Link>
        </div>
      ) : null}
    </SlideOver>
  );
}

export function DeviceDrawer({ deviceId, onClose }: { deviceId: string | null; onClose: () => void }) {
  const { activeTenantId, isAllTenants, tenants } = useTenant();

  const { data: devices } = useQuery({
    queryKey: ["devices", activeTenantId],
    queryFn: () =>
      api.get<Device[]>(isAllTenants ? "/api/devices" : `/api/devices?tenantId=${activeTenantId}`),
    enabled: deviceId !== null && !!activeTenantId,
  });

  const device = devices?.find((d) => d.id === deviceId) ?? null;
  const tenantNames = new Map(tenants.map((t) => [t.tenantId, t.displayName]));

  return (
    <SlideOver open={deviceId !== null} onClose={onClose} title={device?.hostname ?? ""} subtitle="Device">
      {deviceId && !device ? (
        <div className="py-8 text-center text-sm text-slate-400">Loading…</div>
      ) : device ? (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-2">
            <ComplianceChip compliance={device.compliance} />
            <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
              {device.vulnerabilityCount} {device.vulnerabilityCount === 1 ? "vuln" : "vulns"}
            </span>
          </div>
          <section>
            <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">Overview</h4>
            <dl>
              {isAllTenants && (
                <DetailRow label="Customer tenant">
                  {tenantNames.get(device.tenantId) ?? device.tenantId}
                </DetailRow>
              )}
              <DetailRow label="Operating system">{device.os}</DetailRow>
              <DetailRow label="Owner">{device.owner ?? "—"}</DetailRow>
              <DetailRow label="Last seen">
                {device.lastSeen ? new Date(device.lastSeen).toLocaleString() : "—"}
              </DetailRow>
            </dl>
          </section>
          <Link
            to={toDevice(device.id)}
            className="block text-center text-xs font-medium text-indigo-600 hover:text-indigo-700"
          >
            View full detail →
          </Link>
        </div>
      ) : null}
    </SlideOver>
  );
}
