import type { ReactNode } from "react";
import { Card, PageHeader } from "../../../components/ui";
import { ArchitectureDiagram } from "./ArchitectureDiagram";
import { RemediationApiTable } from "./RemediationApiTable";
import { RoleScopeTable } from "./RoleScopeTable";
import { connectionTopology } from "./data/connectionTopology";
import { remediationFlow } from "./data/remediationFlow";
import { remediationOptions } from "./data/remediationOptions";
import { windowsUpdatesFlow } from "./data/windowsUpdatesFlow";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="mb-3 text-base font-semibold text-slate-900">{title}</h2>
      {children}
    </section>
  );
}

/** One domain/URL/path per line, monospaced — for whitelisting lists that read poorly as inline prose. */
function CodeList({ items }: { items: string[] }) {
  return (
    <ul className="mt-2 list-disc space-y-1 pl-5">
      {items.map((item) => (
        <li key={item}>
          <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs">{item}</code>
        </li>
      ))}
    </ul>
  );
}

export function ArchitecturePage() {
  return (
    <div className="pb-12">
      <PageHeader
        title="Architecture"
        subtitle="How PatchPilot connects to the tenants it manages, and what it uses to patch them."
      />

      <div className="max-w-3xl space-y-3 text-sm text-slate-600">
        <p>
          PatchPilot is a single system an MSP runs itself, built to bridge the
          gap between vulnerability management and remediation across every
          customer tenant it manages — one place to see what's exposed and
          act on it, instead of working tenant by tenant inside separate
          Microsoft consoles. It doesn't replace the Microsoft services a
          customer already pays for; it orchestrates them, and it uses the
          GDAP relationship an MSP already holds with that customer to do it
          with the correct, already-established permissions rather than a
          new standing credential of its own.
        </p>
        <p>
          There's no agent on the customer's devices, and PatchPilot installs
          nothing on them. Every finding it shows and every fix it applies
          goes through Microsoft Defender for Endpoint and Intune, in the
          customer's own tenant — using the access an engineer's own
          Microsoft account already has there, home tenant or customer
          tenant, for as long as a single request takes and no longer.
          PatchPilot holds no password or standing key for any customer.
        </p>
      </div>

      <Section title="Prerequisites">
        <p className="mb-4 max-w-3xl text-sm text-slate-600">
          Two tenants are in play here, and each has its own access
          prerequisite before PatchPilot can do anything there at all.
        </p>
        <ul className="mb-6 max-w-3xl list-disc space-y-1 pl-5 text-sm text-slate-600">
          {PREREQUISITES_AT_A_GLANCE.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <h3 className="mb-2 text-sm font-medium text-slate-700">Home tenant</h3>
        <Card className="p-0">
          <dl className="divide-y divide-slate-100">
            {HOME_TENANT_PREREQUISITES.map((item) => (
              <div key={item.title} className="px-5 py-4">
                <dt className="text-sm font-medium text-slate-800">{item.title}</dt>
                <dd className="mt-1 text-sm text-slate-600">{item.body}</dd>
              </div>
            ))}
          </dl>
        </Card>
        <h3 className="mt-4 mb-2 text-sm font-medium text-slate-700">Customer tenant</h3>
        <Card className="p-0">
          <dl className="divide-y divide-slate-100">
            {CUSTOMER_TENANT_PREREQUISITES.map((item) => (
              <div key={item.title} className="px-5 py-4">
                <dt className="text-sm font-medium text-slate-800">{item.title}</dt>
                <dd className="mt-1 text-sm text-slate-600">{item.body}</dd>
              </div>
            ))}
          </dl>
        </Card>
        <h3 className="mt-6 mb-2 text-sm font-medium text-slate-700">
          Entra roles and what they unlock
        </h3>
        <Card className="p-0">
          <RoleScopeTable />
        </Card>
      </Section>

      <Section title="Remediation options, channels, and catalogs">
        <p className="mb-4 max-w-3xl text-sm text-slate-600">
          PatchPilot matches every finding against a set of package/script
          catalogs to work out what the actual fix is, then dispatches it
          through one of several Microsoft-owned channels. Which channel runs
          is picked automatically — Live Response by default — or an
          engineer can override it from the Run Now dialog. Click any box for
          detail, including which of these are real dispatches today and
          which are modeled but not yet used.
        </p>
        <Card>
          <ArchitectureDiagram
            data={remediationOptions}
            ariaLabel="The catalogs PatchPilot resolves a finding against, the remediation channels it can dispatch through, and how each one reaches a managed device"
          />
        </Card>
        <div className="mt-4 max-w-3xl space-y-3 text-sm text-slate-600">
          <p>
            Four catalogs feed a decision, not four separate features:
            winget is the default match for an app finding; Chocolatey and
            the Microsoft Store are a small hand-curated fallback for the
            apps winget doesn't cover; the Windows Update Catalog is
            Microsoft's own live per-tenant list of quality-update releases;
            and the Script Catalog is PatchPilot's library of custom
            PowerShell for findings that map to none of the above — cataloged
            today, but dispatched manually rather than picked automatically.
          </p>
          <p>
            Of the channels, three are genuinely wired end-to-end — Live
            Response (seconds), Intune app deployment (minutes), and Intune's
            Windows Update policies (hours) — and one, Intune's on-demand
            proactive remediation, is fully modeled in the data layer
            (selectable, preflight-checked, present in historical job rows)
            but never actually dispatched by the worker. That gap is
            deliberate: it's kept modeled for a future release rather than
            removed outright.
          </p>
        </div>
      </Section>

      <Section title="How the engineer and PatchPilot reach a tenant">
        <p className="mb-4 max-w-3xl text-sm text-slate-600">
          An engineer signs in with their own Microsoft account, bringing the
          GDAP roles that account already holds in each customer; their browser
          only ever holds a session cookie. When PatchPilot needs to do
          something in a tenant, it asks Microsoft Entra ID for a short-lived
          token for that one tenant and nothing else. Click any box for detail.
        </p>
        <Card>
          <ArchitectureDiagram
            data={connectionTopology}
            ariaLabel="How the engineer and PatchPilot connect to the MSP home tenant and to customer tenants"
          />
        </Card>
        <div className="mt-4 max-w-3xl space-y-3 text-sm text-slate-600">
          <p>
            Customer tenants are reached through a GDAP relationship — the
            delegated-admin agreement set up during onboarding. The token
            PatchPilot receives inherits the roles that the signed-in engineer
            personally holds in that customer, which is why a job always names a
            person. Microsoft does not allow an application to hold GDAP roles
            of its own, so there is no mode in which PatchPilot acts as itself.
          </p>
          <p>
            The MSP's own tenant works slightly differently: it exchanges the
            engineer's live sign-in for a token, so it needs someone actually
            signed in. Customer tenants don't. That difference is what lets an
            overnight schedule run — PatchPilot keeps the owning engineer's
            renewable credential for up to 90 days, and if that engineer stops
            signing in, their schedules stop with a clear message rather than
            failing quietly.
          </p>
        </div>
      </Section>

      <Section title="How a fix reaches a device">
        <p className="mb-4 max-w-3xl text-sm text-slate-600">
          Remediation runs through Defender for Endpoint's Live Response. The
          device is already enrolled in Defender and Intune, so PatchPilot has
          no agent to install — it asks Defender to run a script on the machine
          and then waits for the verdict.
        </p>
        <Card>
          <ArchitectureDiagram
            data={remediationFlow}
            ariaLabel="How a remediation reaches a managed device via Defender for Endpoint and Intune"
          />
        </Card>
        <div className="mt-4 max-w-3xl space-y-3 text-sm text-slate-600">
          <p>
            The script is published to the customer's Live Response library once
            and reused after that — it's named by a hash of its own contents, so
            an unchanged fix is never uploaded twice and a changed one can never
            be confused with the old version. On the device it upgrades the
            package with winget or Chocolatey, or installs a Windows update.
          </p>
          <p>
            PatchPilot decides success from a marker the script prints itself
            rather than trusting the exit code Defender reports, because a
            script can exit zero having done nothing. Intune also lets
            PatchPilot force a device to check in immediately, outside any
            update policy. Everything else Windows-Update-related — feature
            updates, quality updates, update rings, driver updates — goes
            through the Windows Updates hub, covered next. Intune's own
            proactive-remediation channel is recognised but not yet used.
          </p>
        </div>
      </Section>

      <Section title="How Windows updates are identified and delivered">
        <p className="mb-4 max-w-3xl text-sm text-slate-600">
          The Windows Updates hub covers four Intune policy types for a
          tenant: feature updates and quality updates, which PatchPilot can
          create and delete, plus update rings and driver updates, which it
          only reads and displays. "Identified" and "delivered" mean
          different things for each of the two writable types. Click any box
          for detail.
        </p>
        <Card>
          <ArchitectureDiagram
            data={windowsUpdatesFlow}
            ariaLabel="How feature updates and quality updates are identified via the Windows Update catalog and delivered through an Intune policy assigned to an Entra group"
          />
        </Card>
        <div className="mt-4 max-w-3xl space-y-3 text-sm text-slate-600">
          <p>
            A quality update is identified against a real catalog: Microsoft
            publishes the tenant's actual list of monthly (B) and
            out-of-band (OOB) releases, and PatchPilot either matches a
            Defender-reported missing KB against it or lets an engineer pick
            a release directly. A feature update has no such catalog to
            check — PatchPilot just writes the target Windows version label
            (e.g. "24H2") straight into the policy, set once per tenant in
            Settings or overridden per campaign.
          </p>
          <p>
            Delivery for both is the same shape: create an Intune policy
            object and assign it to a real Entra group (feature updates
            always; quality updates too, from the Windows Updates hub's
            release picker — the older Missing KBs "Fix Now"/"Fix All" flow
            instead auto-creates a single-device assignment filter). Once
            assigned, delivery is out of PatchPilot's hands — the device
            pulls the policy on its own Windows Update check-in and installs
            it when due, rather than being pushed to the way a Live Response
            script is. Update rings and driver updates are never created by
            PatchPilot at all; the hub only mirrors whatever's already
            configured in Intune.
          </p>
        </div>
      </Section>

      <Section title="Microsoft APIs used">
        <Card className="p-0">
          <RemediationApiTable />
        </Card>
        <p className="mt-3 max-w-3xl text-xs text-slate-500">
          Defender calls go to{" "}
          <code className="rounded bg-slate-100 px-1 py-0.5 font-mono">
            api.securitycenter.microsoft.com
          </code>
          , Intune calls to{" "}
          <code className="rounded bg-slate-100 px-1 py-0.5 font-mono">
            graph.microsoft.com
          </code>
          . Every one is made with a delegated token for a single tenant and
          recorded in the audit log against the engineer who caused it.
        </p>
      </Section>

      <Section title="Whitelisting requirements">
        <p className="mb-4 max-w-3xl text-sm text-slate-600">
          Two different networks matter here, and only one of them is under
          the MSP's control. PatchPilot's own server needs outbound access to
          the two hosts in "Microsoft APIs used", above, plus{" "}
          <code className="rounded bg-slate-100 px-1 py-0.5 font-mono">
            login.microsoftonline.com
          </code>{" "}
          for auth. Everything below is about the customer's managed
          device instead — the machine Live Response or an Intune
          remediation is actually reaching — which is the network a
          remediation job usually stalls or fails on.
        </p>
        <Card className="p-0">
          <dl className="divide-y divide-slate-100">
            {WHITELISTING_REQUIREMENTS.map((item) => (
              <div key={item.title} className="px-5 py-4">
                <dt className="text-sm font-medium text-slate-800">
                  {item.title}
                </dt>
                <dd className="mt-1 text-sm text-slate-600">{item.body}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </Section>

      <Section title="Known limitations">
        <p className="mb-4 max-w-3xl text-sm text-slate-600">
          PatchPilot works entirely inside Defender's and Intune's own APIs —
          it doesn't bypass them, so it also inherits their gaps. This is what
          it can't do today.
        </p>
        <Card className="p-0">
          <dl className="divide-y divide-slate-100">
            {KNOWN_LIMITATIONS.map((item) => (
              <div key={item.title} className="px-5 py-4">
                <dt className="text-sm font-medium text-slate-800">
                  {item.title}
                </dt>
                <dd className="mt-1 text-sm text-slate-600">{item.body}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </Section>
    </div>
  );
}

const KNOWN_LIMITATIONS: { title: string; body: ReactNode }[] = [
  {
    title: "Exclusions and exceptions are local to PatchPilot",
    body: "Defender has no write API for its own device-exclusion or recommendation-exception features, so excluding a device or granting a CVE exception only suppresses it inside PatchPilot. To stop Defender itself from flagging it, an engineer still has to apply the matching exclusion by hand in the Defender portal.",
  },
  {
    title: "Devices must be enrolled and onboarded to Intune and Microsoft Defender",
    body: "PatchPilot's device inventory comes from Intune's managed-device list, matched to Defender by hostname. A device that was never enrolled in Intune never appears at all — and a device that's enrolled in Intune but hasn't also been onboarded to Defender shows up with unknown compliance, since posture can't be judged without Defender's exposure data. Both steps are required before a device is fully visible here.",
  },
  {
    title: "Windows only",
    body: "Every remediation channel — Live Response, app deployment, and expedited quality updates — targets Windows endpoints. macOS, Linux, iOS, and Android devices can appear in the fleet for visibility, but nothing on them can be remediated.",
  },
  {
    title: "Feature updates are group-only, unlike quality updates",
    body: "The Intune expedite channel pushes a specific security/quality update (a KB) to one device ahead of its ring. Feature updates can't be targeted that way — Microsoft Graph's windowsFeatureUpdateProfiles has no single-device assignment target at all, only a real Entra group (the same limit the Intune admin center itself has). So PatchPilot's feature-update path is a group-targeted, date-scheduled campaign, not a per-device fix.",
  },
  {
    title: "Some findings have nothing to install",
    body: "Bundled or statically-linked libraries (OpenSSL, Log4j, and similar) have to be fixed by the application that ships them, not by updating a package — PatchPilot flags these for manual remediation rather than dispatching a fix. Software with no matching winget or Chocolatey package, and Defender findings that describe a misconfiguration rather than a missing update, can't be dispatched either.",
  },
  {
    title: "No compliance policies, conditional access, or configuration profiles",
    body: "PatchPilot reads device compliance state; it never creates or edits Intune compliance policies, conditional access policies, or configuration profiles. Its only write paths are Live Response scripts, app deployment, and quality-update profiles.",
  },
  {
    title: "Intune's proactive remediation scripts aren't used",
    body: "That channel is recognised in PatchPilot's data model for future use, but nothing is dispatched through it today — every actual fix runs through Live Response or an app deployment instead.",
  },
  {
    title: "Update rings and driver updates are read-only",
    body: "The Windows Updates hub's Update Rings and Driver Updates tabs mirror whatever's already configured in Intune — PatchPilot has no create, edit, or delete path for either. Only feature updates and quality updates are policy types PatchPilot itself writes.",
  },
  {
    title: "Granting or revoking write access needs a Global Administrator",
    body: "The Write access toggle in Settings > Users can only be confirmed by someone who is already a Global Administrator or Privileged Role Administrator in the home tenant (or already a member of PatchPilot Write Access). PatchPilot has no path around this — it's Microsoft's own requirement for modifying a role-assignable group.",
  },
  {
    title: "PatchPilot can't create GDAP relationships",
    body: "Reaching a new customer tenant always starts outside PatchPilot, in Microsoft Partner Center, where the MSP requests a GDAP relationship and the customer approves it. PatchPilot only consumes an already-active relationship; it has no API path to create one. Discovering existing relationships during onboarding also requires the connected admin to be a member of the home tenant's AdminAgents security group, not just Global Administrator.",
  },
  {
    title: "Home-tenant access groups need Entra ID P1/P2, not just Global Administrator",
    body: "Deploy-PatchPilot.ps1 creates PatchPilot Read-Only Access and PatchPilot Write Access as role-assignable security groups, which requires the tenant to hold an Entra ID Premium P1 (or P2) license — a tenant-wide licensing gate, independent of the connected account's own role. Without it, group creation fails with a plain 403 that looks identical to a missing Global Administrator role until the script's own diagnostic spells out which it is. This doesn't block PatchPilot itself: a Global Administrator (or anyone directly assigned the roles listed above) can manage the home tenant exactly the same way without either group.",
  },
];

/** Quick-scan summary shown above the detailed dl blocks below — same facts, short form. */
const PREREQUISITES_AT_A_GLANCE: string[] = [
  "Entra ID P1 or P2 — required for the two home-tenant access groups (bundled in Microsoft 365 Business Premium, EMS E3/E5, or Microsoft 365 E3/E5)",
  "Global Administrator or Privileged Role Administrator — to run the deploy script, and to grant/revoke Write access",
  "Microsoft Intune — for the write actions Intune Administrator and Windows Update Deployment Administrator unlock (bundled in Microsoft 365 Business Premium or Microsoft 365 E3/E5)",
  "Microsoft Defender for Business, or Defender for Endpoint Plan 1+ — for Live Response (bundled in Microsoft 365 Business Premium or Microsoft 365 E3/E5)",
  "A GDAP relationship via Microsoft Partner Center — before PatchPilot can reach a customer tenant at all",
  "Membership in the home tenant's AdminAgents group — to discover existing GDAP relationships during onboarding",
];

const HOME_TENANT_PREREQUISITES: { title: string; body: ReactNode }[] = [
  {
    title: "Entra ID P1 or P2, for the two access groups",
    body: "PatchPilot Read-Only Access and PatchPilot Write Access are role-assignable security groups — a Microsoft Entra ID Premium P1 (or P2) feature, licensed at the tenant level. This is separate from being Global Administrator: a tenant with no P1/P2 license gets an identical 403 Forbidden trying to create one either way, and the two causes look the same until Deploy-PatchPilot.ps1's own warning spells out which (confirmed live — a genuine Global Administrator, on a tenant with no Entra P1, hit exactly this). Bundles that include it: Microsoft 365 Business Premium, EMS E3/E5, Microsoft 365 E3/E5.",
  },
  {
    title: "Global Administrator or Privileged Role Administrator, to deploy",
    body: "Running Deploy-PatchPilot.ps1 for the first time — creating the app registration, granting admin consent, and creating the two home-tenant access groups — requires one of these two Entra roles on the connected account. PatchPilot cannot widen this; it's Microsoft's own requirement for creating role-assignable groups and directory-role assignments.",
  },
  {
    title: "The same roles are required to grant or revoke write access",
    body: "Toggling a user's Write access in Settings > Users redirects to Microsoft for confirmation, and that confirmation only succeeds if the signed-in account is a Global Administrator or Privileged Role Administrator in the home tenant (or already a member of the write group). There's no PatchPilot-side workaround.",
  },
  {
    title: "Without Entra ID P1/P2, a Global Administrator can still manage directly",
    body: "The two groups only exist to delegate home-tenant access to other engineers without making them Global Administrator outright — they're not the only way to hold these roles. PatchPilot only ever checks the signed-in engineer's effective Entra role, never whether it came from one of these groups, so a Global Administrator (or anyone directly assigned Global Reader, Security Reader, Security Administrator, Intune Administrator, and/or Windows Update Deployment Administrator) works exactly the same with no Entra ID P1/P2 license at all.",
  },
  {
    title: "Intune and Defender for Business (or Defender for Endpoint), for what the roles actually unlock",
    body: "Holding a role — however it was granted — only grants the Graph/Defender API permission that role carries; it doesn't license the underlying service. Live Response needs Microsoft Defender for Business or Defender for Endpoint Plan 1 or higher; Intune app deployment, on-demand remediation, and expedited quality/feature updates need Microsoft Intune. Both are bundled into Microsoft 365 Business Premium and Microsoft 365 E3/E5; without them the role exists but the calls it backs have nothing to act on.",
  },
];

const CUSTOMER_TENANT_PREREQUISITES: { title: string; body: ReactNode }[] = [
  {
    title: "A GDAP relationship via Microsoft Partner Center",
    body: "PatchPilot never provisions access to a new customer tenant itself. The MSP must first establish a Granular Delegated Admin Privileges (GDAP) relationship with that customer through Microsoft Partner Center, requesting the roles listed below, before PatchPilot can reach it at all.",
  },
  {
    title: "AdminAgents membership, to discover relationships during onboarding",
    body: "Enumerating existing GDAP relationships — what Deploy-PatchPilot.ps1 does to find customer tenants to onboard — has a Partner Center-specific legacy requirement: the connected account must be a member of the home tenant's AdminAgents security group, in addition to holding Global Administrator directly. Without it, the Graph call returns a genuine success with an empty list rather than an error, so a true Global Administrator can look like they have zero GDAP customers until added to AdminAgents.",
  },
];

const WHITELISTING_REQUIREMENTS: { title: string; body: ReactNode }[] = [
  {
    title: "Defender for Endpoint sensor (every managed device)",
    body: (
      <>
        <p>
          Live Response only works if the device's own Defender sensor can
          reach Microsoft's cloud. This list belongs to Microsoft, not
          PatchPilot, and it's revised periodically — don't hardcode it, run
          the MDE Client Analyzer (Test-MDEConnectivity) on an affected
          device to get the current one. As a starting point:
        </p>
        <CodeList
          items={[
            "winatp-gw-*.microsoft.com  (region-specific gateway)",
            "*.securitycenter.windows.com",
            "*.wd.microsoft.com",
          ]}
        />
        <p className="mt-2">
          A TLS-inspecting proxy or SWG (Zscaler, Umbrella, and similar)
          needs an inspection bypass for these hosts rather than a plain
          firewall allow — Defender pins certificates, so inspection breaks
          the connection silently instead of blocking it outright.
        </p>
      </>
    ),
  },
  {
    title: "Intune Management Extension (app deployment and remediation-script channels)",
    body: (
      <>
        <p>
          Intune app deployment, and the not-yet-used proactive-remediation
          channel, both run through the device's Intune Management
          Extension. Its host list changes independently of Defender's —
          check Microsoft's current Intune network-endpoints documentation
          for the authoritative one:
        </p>
        <CodeList
          items={[
            "manage.microsoft.com",
            "*.manage.microsoft.com",
            "login.microsoftonline.com",
          ]}
        />
      </>
    ),
  },
  {
    title: "AV, EDR, and application-whitelisting exclusions",
    body: (
      <>
        <p>
          This isn't only a third-party-AV problem. Defender's own Attack
          Surface Reduction rules and Controlled Folder Access can block a
          Live Response script or an IME payload even when Defender is the
          only AV on the box, so the same paths need an ASR/Controlled
          Folder Access exclusion there too — not just in whatever runs
          alongside it. And a default-deny application-whitelisting product
          (WDAC, AppLocker, ThreatLocker, Carbon Black App Control, and
          similar) needs an explicit allow rule rather than a scan
          exclusion — path exclusions don't mean anything to a tool that
          blocks everything not explicitly permitted. Paths to cover in
          whichever mechanism applies:
        </p>
        <CodeList
          items={[
            "C:\\ProgramData\\Microsoft\\Windows Defender Advanced Threat Protection\\Downloads\\",
            "C:\\Program Files (x86)\\Microsoft Intune Management Extension\\Content\\",
          ]}
        />
        <p className="mt-2">
          If a schedule's channel resolves to winget or Chocolatey, also
          cover the package manager executables and their temp download
          folders — silent package-manager installs are a common heuristic
          false positive, and an unrecognized winget.exe/choco.exe child
          process is exactly what a whitelisting product default-denies:
        </p>
        <CodeList
          items={[
            "winget.exe",
            "choco.exe",
            "%LOCALAPPDATA%\\Microsoft\\WinGet\\",
            "C:\\ProgramData\\chocolatey\\",
          ]}
        />
      </>
    ),
  },
  {
    title: "Local Windows Firewall is rarely the actual blocker",
    body: "Every connection above is outbound-initiated by the device, which the default Windows Firewall profile allows. It only matters here if a GPO or third-party firewall product explicitly restricts outbound HTTPS — in that case it needs the same host lists as the sensor and IME entries above, not a separate one.",
  },
];
