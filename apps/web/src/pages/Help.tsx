import { Card, PageHeader } from "../components/ui";

interface FaqEntry {
  q: string;
  a: string;
}

const CHANNELS: { name: string; latency: string; use: string }[] = [
  { name: "Defender Live Response", latency: "seconds", use: "Ad-hoc script on a single device — the only channel that runs the moment you click it." },
  { name: "On-demand Intune Remediation", latency: "1–5 min", use: "Targeted script across a group, via Intune's proactive remediation." },
  { name: "Win32 app + sync", latency: "5–15 min", use: "Packaged Winget/Chocolatey upgrade at scale, deployed as a required app." },
  { name: "Microsoft Store app (winGetApp) + sync", latency: "3–10 min", use: "Store-catalog app deployed the same way as a Win32 app." },
  { name: "Expedited Quality Update", latency: "hours", use: "OS quality patches, pushed as an urgent Windows Update policy." },
  { name: "Expedited Feature Update", latency: "hours–days", use: "OS version upgrade, via a feature update deployment profile." },
];

const FAQS: FaqEntry[] = [
  {
    q: "What does \"(preview)\" mean on a catalog pick or a pre-flight check?",
    a: "It means that specific combination of channel and package source doesn't run for real yet — PatchPilot will show you what it would do, but nothing is sent to the device. Only picks without a Preview badge, on a real channel, actually dispatch. If you're ever unsure before a scheduled or urgent fix, check the pre-flight screen — a genuinely live action never carries a preview caveat.",
  },
  {
    q: "Which channel should I use for an urgent, single-device fix?",
    a: "Defender Live Response — it's the only channel that runs in seconds against one device right now. Everything else is scheduled or batched and takes minutes to days.",
  },
  {
    q: "Why can't I run a remediation on a tenant marked read-only?",
    a: "Read-only is a deliberate safety gate — that tenant's admin consent only covers reading data, not making changes. PatchPilot re-checks this at the moment a job actually runs, not just when you schedule it, so it can't be bypassed by scheduling ahead of a permissions change.",
  },
  {
    q: "A scheduled job failed overnight — where do I look?",
    a: "Jobs (left nav) shows every run and its outcome. Remediation History has the longer-lived, attributed record used for reporting. The Audit Log captures every action an engineer or the scheduler took, useful for reconstructing exactly what happened around an incident.",
  },
  {
    q: "What's the difference between Reports and Remediation History?",
    a: "Remediation History is the operational ledger — one row per attempted fix. Reports turns that ledger into a branded, shareable PDF/CSV for a customer or stakeholder, over a date range.",
  },
];

export function Help() {
  return (
    <div>
      <PageHeader
        title="Help"
        subtitle="Quick reference for how PatchPilot's remediation channels and safety gates work."
      />

      <div className="space-y-6">
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-slate-900">Remediation channels</h2>
          <p className="mb-4 text-sm text-slate-500">
            PatchPilot routes each fix to the fastest channel the tenant is licensed for.
            A channel or catalog pick with a <span className="font-medium text-amber-700">Preview</span>{" "}
            badge is modeled end-to-end but does not actually dispatch — see the FAQ below.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                  <th className="py-2 pr-4">Channel</th>
                  <th className="py-2 pr-4">Latency</th>
                  <th className="py-2">Use</th>
                </tr>
              </thead>
              <tbody>
                {CHANNELS.map((c) => (
                  <tr key={c.name} className="border-b border-slate-100 last:border-0">
                    <td className="py-2 pr-4 font-medium text-slate-700">{c.name}</td>
                    <td className="py-2 pr-4 text-slate-500">{c.latency}</td>
                    <td className="py-2 text-slate-500">{c.use}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card>
          <h2 className="mb-3 text-sm font-semibold text-slate-900">Frequently asked</h2>
          <div className="divide-y divide-slate-100">
            {FAQS.map((f) => (
              <div key={f.q} className="py-3 first:pt-0 last:pb-0">
                <div className="text-sm font-medium text-slate-800">{f.q}</div>
                <div className="mt-1 text-sm text-slate-500">{f.a}</div>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <h2 className="mb-2 text-sm font-semibold text-slate-900">Support</h2>
          <p className="text-sm text-slate-500">
            For anything not covered here, contact PatchPilot Support at{" "}
            <a href="mailto:support@patchpilot365.com" className="text-sky-700 hover:underline">
              support@patchpilot365.com
            </a>
            .
          </p>
        </Card>
      </div>
    </div>
  );
}
