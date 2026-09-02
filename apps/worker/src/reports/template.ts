/**
 * The report document, as HTML.
 *
 * Pure template literals — no React, no build step, no browser. `renderPdf` in
 * `render.ts` is what actually needs Chromium; keeping the markup separate is
 * what lets `template.test.ts` assert the document's invariants (everything
 * escaped, nothing fetched, the footer actually visible) in milliseconds rather
 * than behind a browser launch.
 *
 * Three things this file is responsible for that are easy to get wrong:
 *
 * 1. **Escaping.** Hostnames, software titles, tenant names and justifications
 *    come from Graph or from free-text an engineer typed. `apps/web` has React
 *    escaping every one of these; here there is nothing but `h()`. Every
 *    interpolation of non-literal text goes through it.
 * 2. **Self-containment.** The renderer aborts every network request, so an
 *    `@import`, a webfont URL or a remote logo is not a slow chart — it is a
 *    blank one. Fonts are named, never fetched; the only URI in the document is
 *    the branding logo, and it is a `data:` URI or nothing.
 * 3. **Page breaks.** A 50-row overdue table is the point of the compliance
 *    report, and it is unreadable if the header row doesn't repeat or a row is
 *    sliced in half. `thead{display:table-header-group}` plus
 *    `tr{break-inside:avoid}` is what makes it read.
 */
import {
  CHART_NEUTRALS,
  COMPLIANCE_COLORS,
  REPORT_TYPE_DEFS,
  SEVERITY_COLORS,
  SLA_COLORS,
  escapeHtml,
  type AnyReportFacts,
  type ComplianceSlaFacts,
  type ExecutiveSummaryFacts,
  type FindingFact,
  type ReportBranding,
  type ReportChartId,
  type ReportType,
} from "@patchpilot/shared";
import { CHART_TITLES, MONTHS, renderChart, type ChartFacts } from "./charts.js";

/** Everything the document states about itself, assembled by the worker. */
export interface ReportRenderInput {
  reportType: ReportType;
  /** Cover title, resolved by the api so the document names the scope the api
   * actually queried. */
  title: string;
  engineer: string;
  branding: ReportBranding;
  facts: AnyReportFacts;
  /** Section id -> narrated prose. A missing entry falls back to the registry's
   * deterministic caption, which is how one failed section degrades without
   * gapping the document. */
  narration: Readonly<Record<string, string>>;
  /** Whether narration actually happened — an outcome, not a request. */
  narrated: boolean;
  /** Why it didn't, when it was asked for and didn't happen. Printed on the
   * cover: a reader must be able to tell "we chose not to" from "it broke". */
  narrationSkippedReason: string | null;
  factCheckWarnings: readonly string[];
}

const h = escapeHtml;

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Dates are formatted here, not with `toLocaleDateString`. A minimal container
 * carries no ICU data beyond `en-US`, and a printed artefact should read the
 * same whichever host rendered it. UTC throughout, and said so. */
function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1] ?? ""} ${match[1]}`;
}

function formatDateTime(iso: string): string {
  const time = /T(\d{2}):(\d{2})/.exec(iso);
  return time ? `${formatDate(iso)} at ${time[1]}:${time[2]} UTC` : formatDate(iso);
}

function num(value: number): string {
  return value.toLocaleString("en-US");
}

function hoursLabel(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)} h`;
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

type Cell = string | number | null;
type Align = "l" | "r";

/** `align` is per column; anything numeric is right-aligned so a column of
 * counts can be scanned down its last digit. */
function table(
  headers: readonly string[],
  align: readonly Align[],
  rows: readonly (readonly Cell[])[],
  emptyMessage = "Nothing to report.",
): string {
  if (rows.length === 0) return `<p class="muted">${h(emptyMessage)}</p>`;
  const head = headers
    .map((header, i) => `<th class="${align[i] === "r" ? "r" : "l"}">${h(header)}</th>`)
    .join("");
  const body = rows
    .map(
      (row) =>
        `<tr>${row
          .map((cell, i) => `<td class="${align[i] === "r" ? "r" : "l"}">${h(cell)}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

interface Kpi {
  label: string;
  value: string;
  color?: string;
}

function kpiStrip(items: readonly Kpi[]): string {
  const cells = items
    .map(
      (kpi) =>
        `<div class="kpi"><div class="kpi-value" style="color:${kpi.color ?? CHART_NEUTRALS.strong}">${h(kpi.value)}</div>` +
        `<div class="kpi-label">${h(kpi.label)}</div></div>`,
    )
    .join("");
  return `<div class="kpi-strip">${cells}</div>`;
}

/** Narration arrives as prose with blank-line paragraph breaks; captions are a
 * single paragraph. Both go through the same splitter so the two look identical
 * in the finished document. */
function prose(text: string): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return "";
  return paragraphs.map((p) => `<p>${h(p)}</p>`).join("");
}

function figure(id: ReportChartId, svg: string, note?: string): string {
  const caption = note ? `<figcaption class="note">${h(note)}</figcaption>` : "";
  return (
    `<figure class="chart"><figcaption class="chart-title">${h(CHART_TITLES[id])}</figcaption>` +
    `${svg}${caption}</figure>`
  );
}

// ---------------------------------------------------------------------------
// Facts helpers
// ---------------------------------------------------------------------------

function isExecutive(input: ReportRenderInput): input is ReportRenderInput & {
  facts: ExecutiveSummaryFacts;
} {
  return input.reportType === "executive-summary";
}

function isCompliance(input: ReportRenderInput): input is ReportRenderInput & {
  facts: ComplianceSlaFacts;
} {
  return input.reportType === "compliance-sla";
}

/** "14 of 30 requested days captured" — printed under every trend chart and
 * again in the appendix. A thin trend is disclosed, never quietly drawn. */
function trendCoverageNote(facts: AnyReportFacts): string {
  const c = facts.trendCoverage;
  if (c.complete) return `All ${c.requestedDays} requested days are on record.`;
  return (
    `${c.capturedDays} of ${c.requestedDays} requested days captured` +
    (c.firstDay ? `, from ${formatDate(c.firstDay)}.` : ".")
  );
}

function findingRows(rows: readonly FindingFact[], allTenants: boolean): (readonly Cell[])[] {
  return rows.map((f) => {
    const base: Cell[] = [
      f.cveId,
      f.displayName || f.software,
      SEVERITY_COLORS[f.severity].label,
      formatDate(f.detectedAt),
      formatDate(f.dueDate),
      f.daysRemaining,
      f.affectedDeviceCount,
    ];
    return allTenants ? [f.tenantName, ...base] : base;
  });
}

function findingHeaders(allTenants: boolean): { headers: string[]; align: Align[] } {
  const headers = ["CVE", "Software", "Severity", "Detected", "Due", "Days left", "Devices"];
  const align: Align[] = ["l", "l", "l", "l", "l", "r", "r"];
  return allTenants
    ? { headers: ["Tenant", ...headers], align: ["l", ...align] }
    : { headers, align };
}

// ---------------------------------------------------------------------------
// KPI strips
// ---------------------------------------------------------------------------

function kpisFor(input: ReportRenderInput): Kpi[] {
  if (isExecutive(input)) {
    const f = input.facts;
    const coveragePct =
      f.coverage.applicable > 0 ? `${Math.round((f.coverage.covered / f.coverage.applicable) * 100)}%` : "—";
    return [
      { label: "Open findings", value: num(f.tiles.openFindings) },
      { label: "Critical", value: num(f.tiles.critical), color: SEVERITY_COLORS.critical.stroke },
      { label: "Past deadline", value: num(f.tiles.breached), color: SLA_COLORS.breached.stroke },
      { label: "Monitored devices", value: num(f.tiles.devices) },
      {
        label: "Non-compliant devices",
        value: num(f.tiles.noncompliantDevices),
        color: COMPLIANCE_COLORS.noncompliant.stroke,
      },
      { label: "Patchable by PatchPilot", value: coveragePct },
    ];
  }
  const f = (input.facts as ComplianceSlaFacts);
  return [
    { label: "Past deadline", value: num(f.slaCounts.breached), color: SLA_COLORS.breached.stroke },
    { label: "Due within 3 days", value: num(f.slaCounts["due-soon"]), color: SLA_COLORS["due-soon"].stroke },
    { label: "Within deadline", value: num(f.slaCounts.ok), color: SLA_COLORS.ok.stroke },
    { label: "Active exceptions", value: num(f.exceptions.count) },
    { label: "Excluded devices", value: num(f.exclusions.count) },
    { label: "Average time to fix", value: hoursLabel(f.timeToRemediate.avgHours) },
  ];
}

// ---------------------------------------------------------------------------
// Section tables
// ---------------------------------------------------------------------------

/**
 * The tables printed under a section, beyond its charts.
 *
 * Keyed by section id rather than composed into the registry: the registry is
 * imported by `apps/api` and `apps/web` too, and neither has any use for a
 * `<table>`. Adding a report type means one arm here — the same "one switch
 * arm" cost the registry's header advertises.
 */
function sectionTables(sectionId: string, input: ReportRenderInput): string {
  const allTenants = input.facts.meta.tenantId === null;

  if (isExecutive(input)) {
    const f = input.facts;
    switch (sectionId) {
      case "posture-overview":
        return (
          (allTenants
            ? `<h3>Per-tenant summary</h3>` +
              table(
                ["Tenant", "Devices", "Critical", "Past deadline", "Non-compliant", "Last synced"],
                ["l", "r", "r", "r", "r", "l"],
                f.perTenant.map((t) => [
                  t.displayName,
                  num(t.devices),
                  num(t.critical),
                  num(t.slaBreached),
                  num(t.noncompliantDevices),
                  formatDate(t.lastSyncedAt),
                ]),
                "No tenants were reachable for this report.",
              )
            : "") +
          `<h3>Devices needing attention</h3>` +
          table(
            ["Hostname", "Operating system", "Compliance", "Open findings"],
            ["l", "l", "l", "r"],
            f.attentionDevices.map((d) => [
              d.hostname,
              d.os,
              COMPLIANCE_COLORS[d.compliance].label,
              num(d.vulnerabilityCount),
            ]),
            "No device is carrying an outstanding finding.",
          )
        );
      case "sla-performance": {
        const { headers, align } = findingHeaders(allTenants);
        return (
          `<h3>Most urgent findings</h3>` +
          table(headers, align, findingRows(f.urgentFindings, allTenants), "No urgent findings are open.")
        );
      }
      case "coverage":
        return (
          `<h3>Most exposed software titles</h3>` +
          table(
            ["Software", "Severity", "CVEs", "Devices", "PatchPilot can patch"],
            ["l", "l", "r", "r", "l"],
            f.coverage.rows.map((r) => [
              r.displayName,
              SEVERITY_COLORS[r.severity].label,
              num(r.cveCount),
              num(r.affectedDeviceCount),
              r.status === "covered"
                ? `Yes${r.packageId ? ` (${r.packageId})` : ""}`
                : r.status === "os"
                  ? "Operating-system update"
                  : "No supported package",
            ]),
            "No vulnerable software titles were found.",
          )
        );
      default:
        return "";
    }
  }

  if (isCompliance(input)) {
    const f = input.facts;
    switch (sectionId) {
      case "sla-status":
        return allTenants
          ? `<h3>Per-tenant summary</h3>` +
              table(
                ["Tenant", "Devices", "Critical", "Past deadline", "Non-compliant", "Last synced"],
                ["l", "r", "r", "r", "r", "l"],
                f.perTenant.map((t) => [
                  t.displayName,
                  num(t.devices),
                  num(t.critical),
                  num(t.slaBreached),
                  num(t.noncompliantDevices),
                  formatDate(t.lastSyncedAt),
                ]),
                "No tenants were reachable for this report.",
              )
          : "";
      case "breaches": {
        const { headers, align } = findingHeaders(allTenants);
        const breachedNote =
          f.breachedTotal > f.breachedFindings.length
            ? `<p class="note">Showing the ${f.breachedFindings.length} longest-overdue of ${num(f.breachedTotal)}. The full set is available as the SLA compliance CSV export.</p>`
            : "";
        const dueNote =
          f.dueSoonTotal > f.dueSoonFindings.length
            ? `<p class="note">Showing ${f.dueSoonFindings.length} of ${num(f.dueSoonTotal)} findings due within three days.</p>`
            : "";
        return (
          `<h3>Past deadline</h3>` +
          table(headers, align, findingRows(f.breachedFindings, allTenants), "No finding is past its deadline.") +
          breachedNote +
          `<h3>Due within three days</h3>` +
          table(headers, align, findingRows(f.dueSoonFindings, allTenants), "No finding falls due in the next three days.") +
          dueNote
        );
      }
      case "exceptions-exclusions":
        return (
          `<h3>Active exceptions</h3>` +
          table(
            ["Tenant", "Scope", "CVE", "Justification", "Expires", "Raised by"],
            ["l", "l", "l", "l", "l", "l"],
            f.exceptions.rows.map((e) => [
              e.tenantName,
              e.scope,
              e.cveId ?? e.recommendationId ?? "—",
              e.justification,
              formatDate(e.expiresAt),
              e.createdBy,
            ]),
            "No exceptions are in force.",
          ) +
          `<h3>Excluded devices</h3>` +
          table(
            ["Tenant", "Device", "Justification", "Expires", "Excluded by"],
            ["l", "l", "l", "l", "l"],
            f.exclusions.rows.map((e) => [
              e.tenantName,
              e.deviceHostname || e.managedDeviceId,
              e.justification,
              e.expiresAt ? formatDate(e.expiresAt) : "No end date",
              e.createdBy,
            ]),
            "No devices are excluded from monitoring.",
          )
        );
      default:
        return "";
    }
  }

  return "";
}

// ---------------------------------------------------------------------------
// Cover, sections, appendix
// ---------------------------------------------------------------------------

function cover(input: ReportRenderInput): string {
  const meta = input.facts.meta;
  const scope =
    meta.tenantName ?? `All tenants — ${num(meta.tenantCount)} tenant${meta.tenantCount === 1 ? "" : "s"}`;
  // A data: URI or nothing. `safeLogoDataUri` already rejected everything else,
  // and the renderer aborts network requests, so a wordmark is the only
  // fallback that can actually appear.
  const mark = input.branding.logo
    ? `<img class="logo" src="${h(input.branding.logo)}" alt=""/>`
    : `<div class="wordmark">${h(input.branding.productName)}</div>`;

  const narration = input.narrated
    ? "AI-written, from the data in this report"
    : input.narrationSkippedReason
      ? `Data only — ${input.narrationSkippedReason}`
      : "Data only";

  return `<section class="cover">
  <div class="brand-band"></div>
  <div class="cover-body">
    ${mark}
    <h1>${h(input.title)}</h1>
    <dl class="cover-meta">
      <dt>Scope</dt><dd>${h(scope)}</dd>
      <dt>Period</dt><dd>Last ${h(num(meta.windowDays))} days</dd>
      <dt>Generated</dt><dd>${h(formatDateTime(meta.generatedAt))}</dd>
      <dt>Requested by</dt><dd>${h(input.engineer)}</dd>
      <dt>Narration</dt><dd>${h(narration)}</dd>
    </dl>
    <p class="cover-note">Produced by ${h(input.branding.productName)} from data synchronised from Microsoft Defender and Intune. Figures reflect the state at the time of generation.</p>
  </div>
</section>`;
}

function sections(input: ReportRenderInput): string {
  const def = REPORT_TYPE_DEFS[input.reportType];
  const chartFacts = input.facts as unknown as ChartFacts;

  return def.sections
    .map((section) => {
      const narrated = input.narration[section.id]?.trim();
      const body = narrated && narrated.length > 0 ? narrated : section.caption(input.facts);
      const charts = section.charts
        .map((id) => {
          const svg = renderChart(id, chartFacts);
          if (!svg) return "";
          const note =
            id === "posture-trend" || id === "sla-trend" ? trendCoverageNote(input.facts) : undefined;
          return figure(id, svg, note);
        })
        .join("");
      return (
        `<section class="section"><h2>${h(section.title)}</h2>${prose(body)}` +
        `${charts}${sectionTables(section.id, input)}</section>`
      );
    })
    .join("");
}

function appendix(input: ReportRenderInput): string {
  const f = input.facts;
  const t = f.thresholds;
  const exceptionCount = isCompliance(input)
    ? input.facts.exceptions.count
    : isExecutive(input)
      ? input.facts.tiles.activeExceptions
      : 0;
  const exclusionCount = isCompliance(input)
    ? input.facts.exclusions.count
    : isExecutive(input)
      ? input.facts.tiles.excludedDevices
      : 0;

  // The fact-check list goes in the PDF, not only on screen. The old Reports
  // page marked this card `print:hidden`, so the printed artefact silently
  // dropped the one caveat the screen showed — the opposite of what an
  // accuracy note is for.
  const warnings =
    input.factCheckWarnings.length > 0
      ? `<div class="warnbox"><h3>Data verification notes</h3>
    <p>Every numeral in the narrated sections is checked against the figures those sections were built from. The following did not match and should be read with care:</p>
    <ul>${input.factCheckWarnings.map((w) => `<li>${h(w)}</li>`).join("")}</ul></div>`
      : "";

  return `<section class="section appendix">
  <h2>Appendix</h2>
  <h3>Remediation deadlines in force</h3>
  ${table(
    ["Severity", "Deadline from detection"],
    ["l", "r"],
    [
      ["Critical", `${t.critical} days`],
      ["High", `${t.high} days`],
      ["Medium", `${t.medium} days`],
      ["Low", `${t.low} days`],
    ],
  )}
  <h3>Scope and data completeness</h3>
  ${table(
    ["Measure", "Value"],
    ["l", "r"],
    [
      ["Tenants in scope", num(f.scope.tenants)],
      ["Reachable at generation", num(f.scope.reachable)],
      ["Stale (sync overdue)", num(f.scope.stale)],
      ["Never synchronised", num(f.scope.neverSynced)],
      ["Read-only (consent incomplete)", num(f.scope.readOnly)],
      ["Oldest synchronisation", formatDateTime2(f.scope.oldestSyncAt)],
      ["Newest synchronisation", formatDateTime2(f.scope.newestSyncAt)],
      ["Trend history", trendCoverageNote(f)],
      ["Active exceptions", num(exceptionCount)],
      ["Findings suppressed by exceptions", num(f.exceptedFindings)],
      ["Excluded devices", num(exclusionCount)],
      ["Devices removed by exclusions", num(f.excludedDevices)],
    ],
  )}
  ${warnings}
</section>`;
}

function formatDateTime2(iso: string | null): string {
  return iso ? formatDateTime(iso) : "—";
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

/**
 * Print CSS, and why each rule earns its place.
 *
 * `system-ui` is deliberately absent from the font stack: it is undefined in a
 * minimal container and resolves to whatever fallback the engine picks, which
 * is how a report renders in a serif nobody chose. The three named families are
 * exactly what `Dockerfile.worker` installs, with Arial last for a dev box.
 */
function styles(branding: ReportBranding): string {
  return `:root{
  --brand-primary:${branding.primary};
  --brand-secondary:${branding.secondary};
  --brand-accent:${branding.accent};
  --ink:${CHART_NEUTRALS.strong};
  --muted:${CHART_NEUTRALS.label};
  --line:${CHART_NEUTRALS.grid};
  --wash:${CHART_NEUTRALS.cursor};
}
*{box-sizing:border-box}
body{margin:0;color:var(--ink);font-family:"Liberation Sans","DejaVu Sans","Noto Sans",Arial,sans-serif;font-size:10.5px;line-height:1.5;-webkit-print-color-adjust:exact;print-color-adjust:exact}
h1{font-size:26px;line-height:1.2;margin:22px 0 18px}
h2{font-size:15px;margin:0 0 8px;padding-bottom:5px;border-bottom:2px solid var(--brand-primary)}
h3{font-size:11px;margin:16px 0 6px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
p{margin:0 0 8px}
.muted,.note{color:var(--muted)}
.note{font-size:9px;margin-top:4px}

/* The cover owns the first page outright; everything after it flows. */
.cover{break-after:page;page-break-after:always}
.brand-band{height:78px;background:var(--brand-primary);border-bottom:5px solid var(--brand-accent)}
.cover-body{padding:26px 4px 0}
.logo{max-height:52px;max-width:260px;margin-bottom:12px}
.wordmark{font-size:22px;font-weight:700;letter-spacing:-.02em;color:var(--brand-primary)}
.cover-meta{display:grid;grid-template-columns:120px 1fr;gap:5px 12px;margin:20px 0 0;padding:14px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.cover-meta dt{color:var(--muted)}
.cover-meta dd{margin:0;font-weight:600}
.cover-note{margin-top:16px;font-size:9px;color:var(--muted);max-width:520px}

.kpi-strip{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:0 0 18px;break-inside:avoid}
.kpi{border:1px solid var(--line);border-left:3px solid var(--brand-secondary);border-radius:4px;padding:8px 10px}
.kpi-value{font-size:19px;font-weight:700;line-height:1.1}
.kpi-label{font-size:9px;color:var(--muted);margin-top:2px}

/* A section split mid-heading reads as a rendering fault, so keep each whole
   where it fits; a long findings table is allowed to break, its rows are not. */
.section{break-inside:avoid;margin:0 0 20px}
.appendix{break-before:page;page-break-before:always}
figure.chart{break-inside:avoid;margin:12px 0 4px}
.chart-title{font-size:10px;font-weight:600;color:var(--muted);margin-bottom:4px}

table{width:100%;border-collapse:collapse;margin:4px 0 6px;font-size:9.5px}
/* The rule that makes a multi-page table readable: Chromium repeats a
   table-header-group on every page it spans. */
thead{display:table-header-group}
tr{break-inside:avoid;page-break-inside:avoid}
th{text-align:left;font-weight:600;color:var(--muted);border-bottom:1px solid var(--line);padding:4px 6px;white-space:nowrap}
td{border-bottom:1px solid var(--line);padding:4px 6px;vertical-align:top}
tbody tr:nth-child(even){background:var(--wash)}
th.r,td.r{text-align:right;font-variant-numeric:tabular-nums}

.chip{display:inline-block;border:1px solid;border-radius:9px;padding:0 6px;font-size:8.5px;font-weight:600}
.warnbox{border:1px solid ${SLA_COLORS["due-soon"].fill};background:${SLA_COLORS["due-soon"].fill}14;border-radius:5px;padding:10px 12px;margin-top:16px;break-inside:avoid}
.warnbox h3{color:${SLA_COLORS["due-soon"].stroke};margin-top:0}
.warnbox ul{margin:0;padding-left:16px}`;
}

/**
 * Chromium's header/footer templates are a separate mini-document.
 *
 * They inherit **none** of the page's CSS, their default font-size is
 * effectively zero, and they are clipped to the margin box. Every rule here is
 * therefore inline and explicit — an omitted `font-size` is the single most
 * common cause of "my footer isn't rendering", because it renders perfectly at
 * a size nobody can see. `pageNumber` and `totalPages` are the only way to get
 * page numbers out of `page.pdf()` at all.
 */
export function renderHeaderTemplate(input: ReportRenderInput): string {
  const scope = input.facts.meta.tenantName ?? "All tenants";
  return (
    `<div style="font-size:8px;font-family:'Liberation Sans',Arial,sans-serif;color:#64748b;` +
    `width:100%;padding:0 14mm;display:flex;justify-content:space-between;align-items:center;">` +
    `<span style="font-size:8px;color:${input.branding.primary};font-weight:700;">${h(input.branding.productName)}</span>` +
    `<span style="font-size:8px;">${h(input.title)} — ${h(scope)}</span></div>`
  );
}

export function renderFooterTemplate(input: ReportRenderInput): string {
  const generated = formatDateTime(input.facts.meta.generatedAt);
  return (
    `<div style="font-size:8px;font-family:'Liberation Sans',Arial,sans-serif;color:#64748b;` +
    `width:100%;padding:0 14mm;display:flex;justify-content:space-between;align-items:center;">` +
    `<span style="font-size:8px;">Generated ${h(generated)} for ${h(input.engineer)}</span>` +
    `<span style="font-size:8px;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`
  );
}

/** The complete document. Delivered via `page.setContent`, so there is no temp
 * file, no `file://` and nothing shared between the api and worker containers. */
export function renderReportHtml(input: ReportRenderInput): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${h(input.title)}</title>
<style>${styles(input.branding)}</style></head>
<body>${cover(input)}${kpiStrip(kpisFor(input))}${sections(input)}${appendix(input)}</body></html>`;
}
