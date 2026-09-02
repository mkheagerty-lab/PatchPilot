/**
 * Report-generation env, parsed worker-side.
 *
 * `apps/api/src/config.ts` is not reachable from here (different app, not an
 * importable package — same constraint `ai-report-worker.ts` documents and
 * `scheduler.ts` established), so the variables this process needs are
 * re-declared below with the same zod shapes and defaults. Two of them —
 * `REPORT_RETENTION_DAYS` and `REPORT_MAX_BYTES` — also exist in the api's
 * config because the api stamps `expires_at` at INSERT; those two are kept in
 * sync BY HAND, and their defaults must match or a report will be stamped with
 * one retention and swept on another. The rest are worker-only.
 *
 * The AI fields are here too, absorbing `AiEnvSchema` from
 * `ai-report-worker.ts` (which this feature replaces) so there is one env
 * parse for report generation rather than two.
 */
import { z } from "zod";

const ReportEnvSchema = z.object({
  /**
   * Kill switch for PDF rendering specifically — NOT for reports as a whole.
   * With this false the worker still drains the queue and still marks each
   * report terminal (`failed`, with a clear reason), which is what keeps a
   * deployment that cannot run Chromium from parking rows at `pending`
   * forever. Deliberately separate from `AI_FEATURES_ENABLED`: narration is a
   * capability, rendering is the product.
   */
  REPORT_PDF_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  /**
   * Where Chromium lives. Empty means "let Playwright resolve it", which is
   * what a Debian image with `playwright install chromium` wants; the alpine
   * image sets it to /usr/bin/chromium-browser.
   *
   * This is env-configured precisely so the escape hatch — swapping
   * `Dockerfile.worker` to node:22-bookworm-slim + `playwright install
   * --with-deps chromium` if alpine's Chromium drifts — stays a Dockerfile
   * change and never a code change. Never hardcode an executable path.
   */
  REPORT_BROWSER_EXECUTABLE_PATH: z.string().optional(),

  /**
   * A Playwright browser channel, used INSTEAD of a bundled/system binary.
   * On a Windows dev box `msedge` drives the already-installed Edge, so there
   * is nothing to download to work on this feature locally. Left empty in
   * every container.
   */
  REPORT_BROWSER_CHANNEL: z.string().optional(),

  /** Bound on `page.pdf()` alone. A render that needs longer than this is
   * wedged, not slow — the document is fully self-contained and fetches
   * nothing. */
  REPORT_PDF_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(60_000),

  /** Backstop above every timeout inside one report run (narration included),
   * mirroring `JOB_TIMEOUT_MS` in index.ts: guarantees the row reaches a
   * terminal status instead of parking at `rendering` forever. Must exceed
   * `REPORT_PDF_TIMEOUT_MS` plus the narration budget. */
  REPORT_JOB_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(300_000),

  /** One at a time. Chromium peaks at 250-400 MB per render, and narration is
   * already serialized behind a single-model Ollama, so a second concurrent
   * report buys nothing and costs memory. */
  REPORT_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),

  /** Kept in sync by hand with apps/api/src/config.ts. */
  REPORT_MAX_BYTES: z.coerce.number().int().min(1).default(25 * 1024 * 1024),

  /** Kept in sync by hand with apps/api/src/config.ts. The api stamps
   * `expires_at` from it at INSERT; the worker only compares against the
   * stamped value, never recomputes it. */
  REPORT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),

  /** Per-engineer cap enforced after each successful write, oldest deleted
   * first. Bounds the table for someone who generates reports all day and
   * never revisits them. */
  REPORT_RETENTION_MAX_PER_ENGINEER: z.coerce.number().int().min(1).default(50),

  // --- AI, absorbed from ai-report-worker.ts's AiEnvSchema ----------------
  AI_FEATURES_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  OLLAMA_BASE_URL: z.string().url().default("http://localhost:11434"),
  OLLAMA_MODEL: z.string().default("llama3.1:8b"),
  OLLAMA_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(180_000),
});

export type ReportEnv = z.infer<typeof ReportEnvSchema>;

/**
 * An empty string is treated as ABSENT, not as a value. A container image or a
 * `.env` that carries a bare `REPORT_BROWSER_CHANNEL=` line means "no
 * channel"; passing `""` straight through would have Playwright look for a
 * browser channel literally named "" and throw at launch, on the first report
 * anyone generates. Same for an empty executable path.
 *
 * Exported as a function, not just the parsed constant, so this rule is
 * testable without mutating `process.env`.
 */
export function parseReportEnv(source: NodeJS.ProcessEnv): ReportEnv {
  return ReportEnvSchema.parse(
    Object.fromEntries(Object.entries(source).filter(([, v]) => v !== "")),
  );
}

/** Parsed once at import, like `config` in the api. */
export const reportEnv: ReportEnv = parseReportEnv(process.env);
