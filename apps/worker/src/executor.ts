import { and, eq } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import {
  CHANNEL_SPECS,
  isExclusionLive,
  compareWingetVersions,
  DEVICE_EXCLUSION_JUSTIFICATION_LABELS,
  type RemediationJob,
  type Win32Source,
} from "@patchpilot/shared";
import {
  env,
  graphWrite,
  GraphError,
  findQualityUpdateCatalogItem,
  ensureDeviceAssignmentFilter,
  createAndAssignQualityUpdateProfile,
  buildAssignmentTargets,
  getMobileApp,
  assertWritesAllowed,
  reserveLiveResponseDeviceSlot,
} from "@patchpilot/graph";
import {
  runLiveResponseRemediation,
  runLiveResponseKbRemediation,
  runLiveResponseChocolateyRemediation,
} from "./live-response.js";

/**
 * The real remediation executor (Phase 5, Workstream B).
 *
 * This is where a queued job actually becomes a Microsoft write — or is honestly
 * refused. Three invariants shape it:
 *
 *  1. **DEMO_MODE simulates, never calls.** With DEMO_MODE on, no Microsoft API
 *     is touched; the executor returns the exact script that *would* run, mirroring
 *     the api's in-memory simulation. The worker normally isn't even running in
 *     demo, but this keeps the code path honest if it is.
 *
 *  2. **The write gate is enforced HERE, at execution time** (invariant #11). The
 *     api route already blocks a closed write gate at request time, but a
 *     *scheduled* job may run hours or days later, by which point the tenant's
 *     own posture — or the vendor's entitlement — could have changed. So the
 *     worker re-checks `assertWritesAllowed` now and refuses the write if it's
 *     closed. Device exclusion is re-read the same way and for the same reason
 *     — see (3) below.
 *
 *  3. **Never report a write that didn't happen.** A channel either issues a real
 *     `graphWrite` and reports the actual HTTP result, or it returns an explicit
 *     "not performed — requires X" result. Today only the Intune device-sync
 *     channel is a complete, self-contained call (it needs nothing but the managed
 *     device id); the other three require tenant-side configuration we don't
 *     synthesize, so they say so rather than faking success.
 */

export interface ExecutionResult {
  exitCode: number;
  output: string;
}

/** The engineer's MSP home tenant — home uses OBO, customers use SAM (see graph/client). */
const HOME_TENANT_ID = env.ENTRA_TENANT_ID;

function notPerformed(label: string, reason: string): ExecutionResult {
  return { exitCode: 1, output: `${label}: no write performed — ${reason}` };
}

export async function executeRemediation(
  payload: RemediationJob,
  onProgress?: (transcript: string) => void | Promise<void>,
): Promise<ExecutionResult> {
  const spec = CHANNEL_SPECS[payload.channel];

  // (1) DEMO_MODE: simulate, never call Microsoft.
  if (env.DEMO_MODE) {
    return {
      exitCode: 0,
      output:
        `[demo] Simulated execution — no Microsoft API was called.\n` +
        `# Channel: ${spec.label} (${spec.endpointTemplate})\n` +
        `# This is the exact script that would run on the device:\n\n${payload.script ?? ""}`,
    };
  }

  try {
    // (2) Authoritative write-gate check, re-checked at execution time.
    const [tenant] = await db
      .select()
      .from(tables.tenants)
      .where(eq(tables.tenants.tenantId, payload.tenantId))
      .limit(1);

    if (!tenant) {
      return { exitCode: 1, output: `Tenant ${payload.tenantId} not found — no action taken.` };
    }
    const writeGate = await assertWritesAllowed(tenant);
    if (!writeGate.allowed) {
      return notPerformed(
        spec.label,
        `${writeGate.reason} (re-checked at execution time; posture may have changed since the job was queued)`,
      );
    }

    // Resolve the device's channel-specific target id from the DB at execution time.
    const [device] = payload.deviceId
      ? await db.select().from(tables.devices).where(eq(tables.devices.id, payload.deviceId)).limit(1)
      : [undefined];

    // (3) Device exclusion, re-checked at execution time for exactly the same
    // reason as read-only above: preflight already refused excluded devices when
    // the job was enqueued, but a scheduled job may run hours or days later, and
    // the engineer may have excluded the device in between. Refusing here is the
    // difference between "excluded" meaning something and meaning nothing.
    if (device) {
      const [exclusion] = await db
        .select()
        .from(tables.deviceExclusions)
        .where(
          and(
            eq(tables.deviceExclusions.tenantId, payload.tenantId),
            eq(tables.deviceExclusions.managedDeviceId, device.managedDeviceId),
            eq(tables.deviceExclusions.status, "active"),
          ),
        )
        .limit(1);
      if (exclusion && isExclusionLive(exclusion)) {
        return notPerformed(
          spec.label,
          `${device.hostname} is excluded from PatchPilot (${
            DEVICE_EXCLUSION_JUSTIFICATION_LABELS[exclusion.justification]
          }; the exclusion may have been added after the job was queued)`,
        );
      }
    }

    // (4) Smart targeting, re-checked at execution time for the same reason as
    // (2)/(3) above: a scheduled job may run hours after it was enqueued, and
    // the device may have already picked up the fix in the interim (e.g.
    // Chrome's own background updater) — same local-DB-only freshness signal
    // fanOutSchedule's pre-filter uses (deviceVulnerabilities.softwareVersion
    // vs. wingetCatalog.latestVersion via compareWingetVersions), just
    // re-checked here in case the device patched *after* the job was already
    // queued. Unlike the notPerformed() refusals above, an already-up-to-date
    // device is the schedule working correctly, not a blocked write — so this
    // resolves on the normal succeeded path (exitCode 0) with the reason
    // folded into `output`, rather than a new job status.
    if (payload.cveId && device?.defenderMachineId) {
      const [vuln] = await db
        .select()
        .from(tables.vulnerabilities)
        .where(
          and(
            eq(tables.vulnerabilities.tenantId, payload.tenantId),
            eq(tables.vulnerabilities.cveId, payload.cveId),
          ),
        )
        .limit(1);
      if (vuln?.wingetPackageId) {
        const [link] = await db
          .select()
          .from(tables.deviceVulnerabilities)
          .where(
            and(
              eq(tables.deviceVulnerabilities.tenantId, payload.tenantId),
              eq(tables.deviceVulnerabilities.defenderMachineId, device.defenderMachineId),
              eq(tables.deviceVulnerabilities.cveId, payload.cveId),
            ),
          )
          .limit(1);
        if (link?.softwareVersion) {
          const [catalogEntry] = await db
            .select()
            .from(tables.wingetCatalog)
            .where(eq(tables.wingetCatalog.packageId, vuln.wingetPackageId))
            .limit(1);
          if (
            catalogEntry?.latestVersion &&
            compareWingetVersions(link.softwareVersion, catalogEntry.latestVersion) >= 0
          ) {
            return {
              exitCode: 0,
              output:
                `[skipped — already up to date] ${spec.label}: ${device.hostname} already has ` +
                `${vuln.software} ${link.softwareVersion}, which meets or exceeds the catalog's ` +
                `latest known version (${catalogEntry.latestVersion}). No write performed.`,
            };
          }
        }
      }
    }

    switch (payload.channel) {
      case "win32-app": {
        // The app is created-or-reused inline at dispatch time (Run Now /
        // Fix All, apps/api/src/routes/jobs.ts) via deployOrReuseWin32App —
        // Name/Description/Assignment are set there, live against Graph,
        // before this job is even enqueued. This channel's job is narrower:
        // confirm the assigned app still exists, then nudge the device to
        // pick it up sooner via syncDevice. It deliberately never creates or
        // reassigns an app itself — Intune's assign call REPLACES the whole
        // assignment list, so touching it here would silently un-assign every
        // other device already covered by a standing group/device assignment
        // the engineer configured by hand. The lookup-failure branches below
        // are a defensive fallback for an app deleted or unassigned
        // out-of-band since dispatch, not the primary path.
        const managedDeviceId = device?.managedDeviceId;
        if (!managedDeviceId) {
          return notPerformed(spec.label, "device has no Intune managed device id");
        }

        // Same source-resolution priority as the Live Response case above: an
        // engineer-selected Chocolatey alternate beats the winget mapping.
        // "script" tags a win32-app deploy of a Script Catalog entry — see
        // RemediationJob.source in queue.ts.
        let win32Source: Win32Source = "winget";
        let win32PackageId = payload.packageId ?? undefined;
        if (payload.source === "chocolatey" && payload.altPackageId) {
          win32Source = "chocolatey";
          win32PackageId = payload.altPackageId;
        } else if (payload.source === "script" && payload.altPackageId) {
          win32Source = "script";
          win32PackageId = payload.altPackageId;
        }
        if (!win32PackageId && payload.cveId) {
          const [vuln] = await db
            .select()
            .from(tables.vulnerabilities)
            .where(
              and(
                eq(tables.vulnerabilities.tenantId, payload.tenantId),
                eq(tables.vulnerabilities.cveId, payload.cveId),
              ),
            )
            .limit(1);
          win32PackageId = vuln?.wingetPackageId ?? undefined;
        }
        if (!win32PackageId) {
          return notPerformed(
            spec.label,
            "no mapped winget/Chocolatey package for this software",
          );
        }

        const [deployment] = await db
          .select()
          .from(tables.intuneAppDeployments)
          .where(
            and(
              eq(tables.intuneAppDeployments.tenantId, payload.tenantId),
              eq(tables.intuneAppDeployments.source, win32Source),
              eq(tables.intuneAppDeployments.packageId, win32PackageId),
            ),
          )
          .limit(1);
        if (!deployment) {
          return notPerformed(
            spec.label,
            `no Win32 app has been deployed for ${win32Source}:${win32PackageId} yet — dispatch via the Intune (Win32 app) channel to create and assign it`,
          );
        }

        const app = await getMobileApp({
          engineer: payload.engineer,
          homeTenantId: HOME_TENANT_ID,
          tenantId: payload.tenantId,
          appId: deployment.intuneAppId,
        });
        if (!app) {
          return notPerformed(
            spec.label,
            `Win32 app ${deployment.intuneAppId} no longer exists in Intune — redeploy it via the Intune (Win32 app) channel`,
          );
        }
        if (!app.assignments || app.assignments.length === 0) {
          return notPerformed(
            spec.label,
            `"${app.displayName ?? win32PackageId}" exists in Intune but has no assignment — redeploy via the Intune (Win32 app) channel to set one`,
          );
        }

        const res = await graphWrite({
          engineer: payload.engineer,
          homeTenantId: HOME_TENANT_ID,
          tenantId: payload.tenantId,
          host: "graph",
          method: "POST",
          path: `/deviceManagement/managedDevices/${managedDeviceId}/syncDevice`,
        });
        if (res.ok) {
          return {
            exitCode: 0,
            output: `${spec.label}: "${app.displayName ?? win32PackageId}" is assigned and Intune-ready — device sync queued (HTTP ${res.status}) to expedite pickup.`,
          };
        }
        // The app is already confirmed assigned above — that's the correctness-
        // critical part, and it's done. syncDevice only expedites pickup; without
        // it Intune still installs on the device's normal check-in cadence (up to
        // 8h). So a failure here (e.g. HTTP 403 from a tenant that hasn't granted
        // DeviceManagementManagedDevices.PrivilegedOperations.All, which this
        // specific call requires — see scopes.ts) is a soft warning, not a job
        // failure.
        return {
          exitCode: 0,
          output: `${spec.label}: "${app.displayName ?? win32PackageId}" is assigned and Intune-ready, but the device-sync nudge failed (HTTP ${res.status}) — it will still install on the device's normal Intune check-in cycle.`,
        };
      }

      case "winget-app": {
        // The app is created-or-reused inline at dispatch time (Run Now,
        // apps/api/src/routes/jobs.ts) via deployOrReuseWinGetApp — Name/
        // Description/Assignment are set there, live against Graph, before
        // this job is even enqueued. Same narrow-job reasoning as the
        // win32-app case above: confirm the assigned app still exists, then
        // nudge the device to pick it up sooner via syncDevice.
        const managedDeviceId = device?.managedDeviceId;
        if (!managedDeviceId) {
          return notPerformed(spec.label, "device has no Intune managed device id");
        }

        // jobs.ts's runWinGetAppDeploy tags every winget-app dispatch with
        // `source: "microsoft-store"` + the Store package id in altPackageId
        // (see RemediationJob.source in queue.ts) — "microsoft-store" is
        // never used as a Win32Source, so this lookup can't collide with the
        // win32-app case's rows above even without also filtering on appType.
        const storePackageId = payload.altPackageId ?? undefined;
        if (!storePackageId) {
          return notPerformed(spec.label, "no Microsoft Store package id for this dispatch");
        }

        const [deployment] = await db
          .select()
          .from(tables.intuneAppDeployments)
          .where(
            and(
              eq(tables.intuneAppDeployments.tenantId, payload.tenantId),
              eq(tables.intuneAppDeployments.source, "microsoft-store"),
              eq(tables.intuneAppDeployments.packageId, storePackageId),
            ),
          )
          .limit(1);
        if (!deployment) {
          return notPerformed(
            spec.label,
            `no Microsoft Store app has been deployed for ${storePackageId} yet — dispatch via the Microsoft Store app (new) channel to create and assign it`,
          );
        }

        const app = await getMobileApp({
          engineer: payload.engineer,
          homeTenantId: HOME_TENANT_ID,
          tenantId: payload.tenantId,
          appId: deployment.intuneAppId,
        });
        if (!app) {
          return notPerformed(
            spec.label,
            `Microsoft Store app ${deployment.intuneAppId} no longer exists in Intune — redeploy it via the Microsoft Store app (new) channel`,
          );
        }
        if (!app.assignments || app.assignments.length === 0) {
          return notPerformed(
            spec.label,
            `"${app.displayName ?? storePackageId}" exists in Intune but has no assignment — redeploy via the Microsoft Store app (new) channel to set one`,
          );
        }

        const res = await graphWrite({
          engineer: payload.engineer,
          homeTenantId: HOME_TENANT_ID,
          tenantId: payload.tenantId,
          host: "graph",
          method: "POST",
          path: `/deviceManagement/managedDevices/${managedDeviceId}/syncDevice`,
        });
        if (res.ok) {
          return {
            exitCode: 0,
            output: `${spec.label}: "${app.displayName ?? storePackageId}" is assigned and Intune-ready — device sync queued (HTTP ${res.status}) to expedite pickup.`,
          };
        }
        return {
          exitCode: 0,
          output: `${spec.label}: "${app.displayName ?? storePackageId}" is assigned and Intune-ready, but the device-sync nudge failed (HTTP ${res.status}) — it will still install on the device's normal Intune check-in cycle.`,
        };
      }

      case "live-response": {
        // Fully automated Defender path. Needs the device's Defender machine
        // id either way; the target and library script differ by finding kind.
        const machineId = device?.defenderMachineId;
        if (!machineId) {
          return notPerformed(spec.label, "device has no Defender machine id");
        }

        // PatchPilot's per-tenant Live Response device quota — authoritative,
        // last-mile check AND the actual reservation, right before any real
        // dispatch. A job enqueued but never executed must never consume a
        // slot, so this happens here, not at enqueue time (see preflight()'s
        // "live-response-quota" check for the earlier, read-only warning).
        const quota = await reserveLiveResponseDeviceSlot(payload.tenantId, {
          id: device!.id,
          managedDeviceId: device!.managedDeviceId,
          hostname: device!.hostname,
        });
        if (!quota.allowed) {
          return notPerformed(spec.label, quota.reason);
        }

        // Missing-KB (OS) dispatch: the WUA COM script for this specific KB,
        // baked in rather than passed as an Args token.
        if (payload.kbId) {
          return runLiveResponseKbRemediation({
            engineer: payload.engineer,
            homeTenantId: HOME_TENANT_ID,
            tenantId: payload.tenantId,
            machineId,
            kbId: payload.kbId,
            onProgress,
          });
        }

        // App (CVE) dispatch. An engineer-selected alternate source (winget has
        // no package for this app — see RemediationJob.source in queue.ts) beats
        // the winget mapping outright, mirroring remediationScript()'s priority
        // in scripts.ts so the job matches the script the engineer reviewed.
        if (payload.source === "chocolatey" && payload.altPackageId) {
          return runLiveResponseChocolateyRemediation({
            engineer: payload.engineer,
            homeTenantId: HOME_TENANT_ID,
            tenantId: payload.tenantId,
            machineId,
            packageId: payload.altPackageId,
            onProgress,
          });
        }

        // Engineer-selected/auto-matched package (Run Now dialog) beats the
        // stored mapping. Software-inventory jobs have no CVE at all, so this
        // is the only source of the package id for them — only fall back to
        // the vulnerabilities table when there's a CVE to look up.
        let wingetId = payload.packageId ?? undefined;
        if (!wingetId && payload.cveId) {
          const [vuln] = await db
            .select()
            .from(tables.vulnerabilities)
            .where(
              and(
                eq(tables.vulnerabilities.tenantId, payload.tenantId),
                eq(tables.vulnerabilities.cveId, payload.cveId),
              ),
            )
            .limit(1);
          wingetId = vuln?.wingetPackageId ?? undefined;
        }
        if (!wingetId) {
          return notPerformed(
            spec.label,
            "only winget-remediable findings run via Live Response today (no mapped winget package for this software)",
          );
        }
        return runLiveResponseRemediation({
          engineer: payload.engineer,
          homeTenantId: HOME_TENANT_ID,
          tenantId: payload.tenantId,
          machineId,
          packageId: wingetId,
          installScope: payload.installScope,
          action: payload.action,
          onProgress,
        });
      }

      // The remaining channels each require tenant-side configuration we do not
      // (and should not silently) create. Be explicit rather than fake a write.
      case "intune-remediation":
        return notPerformed(
          spec.label,
          "on-demand proactive remediation requires an existing remediation script policy (scriptPolicyId) provisioned in Intune to target",
        );
      case "expedited-quality-update": {
        // Matches a Defender missing-KB id to an Intune Windows Update catalog
        // item, then creates + assigns a windowsQualityUpdateProfile scoped to
        // this one device via a hostname-based assignment filter.
        const hostname = device?.hostname;
        if (!device?.managedDeviceId || !hostname) {
          return notPerformed(spec.label, "device has no Intune managed device id");
        }
        if (!payload.kbId) {
          return notPerformed(spec.label, "job has no missing-KB id to remediate");
        }
        // An engineer-chosen release (via the Expedited Quality Update options
        // panel) skips the KB-match lookup entirely — they already picked a
        // specific catalog item, so re-deriving one here would risk overriding
        // their choice with the auto-matched default.
        let catalogItemId = payload.qualityUpdateCatalogItemId ?? undefined;
        if (!catalogItemId) {
          const catalogItem = await findQualityUpdateCatalogItem({
            engineer: payload.engineer,
            homeTenantId: HOME_TENANT_ID,
            tenantId: payload.tenantId,
            kbId: payload.kbId,
          });
          if (!catalogItem) {
            return notPerformed(
              spec.label,
              `no Intune Windows Update catalog item found for KB${payload.kbId}`,
            );
          }
          if (catalogItem.isExpeditable === false) {
            return notPerformed(
              spec.label,
              `KB${payload.kbId} (${catalogItem.displayName ?? catalogItem.id}) is not expeditable via Intune`,
            );
          }
          catalogItemId = catalogItem.id;
        }
        const filterId = await ensureDeviceAssignmentFilter({
          engineer: payload.engineer,
          homeTenantId: HOME_TENANT_ID,
          tenantId: payload.tenantId,
          hostname,
        });
        const targets = buildAssignmentTargets({ mode: "all-devices", filterId });
        const profileId = await createAndAssignQualityUpdateProfile({
          engineer: payload.engineer,
          homeTenantId: HOME_TENANT_ID,
          tenantId: payload.tenantId,
          catalogItemId,
          kbId: payload.kbId,
          targets,
          displayName: payload.qualityUpdateDisplayName ?? undefined,
          daysUntilForcedReboot: (payload.qualityUpdateDaysUntilForcedReboot ?? undefined) as
            | 0
            | 1
            | 2
            | undefined,
        });
        return {
          exitCode: 0,
          output:
            `${spec.label}: created and assigned windowsQualityUpdateProfile ${profileId} for KB${payload.kbId} ` +
            `scoped to ${hostname} (assignment filter ${filterId}).`,
        };
      }
      default:
        return notPerformed(spec.label, "channel not implemented");
    }
  } catch (err) {
    // A GraphError (e.g. 401 no token, 403 missing scope) is an honest failure —
    // surface its status/message rather than letting BullMQ swallow it as a retry.
    if (err instanceof GraphError) {
      return { exitCode: 1, output: `${spec.label}: ${err.message} (HTTP ${err.status}).` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { exitCode: 1, output: `${spec.label}: execution error — ${message}` };
  }
}
