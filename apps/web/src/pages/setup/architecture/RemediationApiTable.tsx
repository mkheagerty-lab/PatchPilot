interface ApiRow {
  purpose: string;
  api: string;
  endpoint: string;
}

const ROWS: ApiRow[] = [
  {
    purpose: "Runs the fix — every remediation takes this path",
    api: "Defender for Endpoint",
    endpoint: "POST /api/machines/{id}/runliveresponse",
  },
  {
    purpose: "Watches it finish",
    api: "Defender for Endpoint",
    endpoint: "GET /api/machineactions/{id}",
  },
  {
    purpose: "Publishes the script to the tenant's library",
    api: "Defender for Endpoint",
    endpoint: "GET / POST /api/libraryfiles",
  },
  {
    purpose: "Forces a device to check in",
    api: "Intune (Graph v1.0)",
    endpoint: "POST /deviceManagement/managedDevices/{id}/syncDevice",
  },
  {
    purpose: "Expedites a Windows quality update",
    api: "Intune (Graph beta)",
    endpoint: "POST /deviceManagement/windowsQualityUpdateProfiles + /assign",
  },
  {
    purpose: "Reads the tenant's catalog of available quality updates",
    api: "Intune (Graph beta)",
    endpoint: "GET /deviceManagement/windowsUpdateCatalogItems",
  },
  {
    purpose: "Creates + assigns a feature-update policy",
    api: "Intune (Graph beta)",
    endpoint: "POST /deviceManagement/windowsFeatureUpdateProfiles + /assign",
  },
  {
    purpose: "Reads update rings and driver-update policy (read-only)",
    api: "Intune (Graph beta)",
    endpoint: "GET /deviceManagement/deviceConfigurations (isof filter), /deviceManagement/windowsDriverUpdateProfiles",
  },
  {
    purpose: "Finds what needs fixing (read-only)",
    api: "Defender for Endpoint",
    endpoint: "GET /api/machines/SoftwareVulnerabilitiesByMachine, /api/recommendations",
  },
];

export function RemediationApiTable() {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            <th className="px-5 py-3 font-medium">What it does</th>
            <th className="px-5 py-3 font-medium">API</th>
            <th className="px-5 py-3 font-medium">Endpoint</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr key={row.endpoint} className="border-b border-slate-100 last:border-0">
              <td className="px-5 py-3 text-slate-700">{row.purpose}</td>
              <td className="px-5 py-3 whitespace-nowrap text-slate-600">{row.api}</td>
              <td className="px-5 py-3 font-mono text-xs text-slate-500">{row.endpoint}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
