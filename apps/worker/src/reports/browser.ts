/**
 * The headless Chromium the report renderer draws into.
 *
 * `playwright-core`, not `playwright`: the full package downloads ~150 MB of
 * browser on every install, which the container then overrides with the
 * system Chromium anyway (there are no musl builds, so alpine forces the
 * system binary regardless). `-core` is the same API with no postinstall.
 *
 * Nothing here knows what a report looks like — `render.ts` owns the document
 * and the page setup. This file owns exactly one thing: a browser process
 * that survives across jobs and heals after a crash.
 */
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { reportEnv } from "./env.js";

/**
 * Lazy, not launched at import — same reasoning as `packages/db/src/client.ts`'s
 * lazy proxy. A deployment that never generates a report never spawns
 * Chromium, and a worker whose real job is remediation still boots on a box
 * with no browser installed at all.
 */
let instance: Browser | null = null;
let launching: Promise<Browser> | null = null;

/**
 * `--no-sandbox`: the container runs as root with no user namespaces, where
 *   Chromium's sandbox cannot initialise and the process exits immediately.
 * `--disable-dev-shm-usage`: Docker gives /dev/shm 64 MB by default, and a
 *   render that outgrows it dies as an opaque "Target closed". Forces the
 *   shared-memory-backed surfaces into /tmp instead.
 * `--disable-gpu`, `--font-render-hinting=none`: deterministic rasterisation,
 *   so the same facts produce the same PDF on a dev box and in the container.
 * `--hide-scrollbars`: otherwise a tall table paints a scrollbar gutter into
 *   the printed page.
 */
const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--font-render-hinting=none",
  "--hide-scrollbars",
];

async function launch(): Promise<Browser> {
  const browser = await chromium.launch({
    // Both optional and mutually exclusive in practice: a channel names an
    // installed branded browser (Edge on a Windows dev box), a path names a
    // binary (the container's system Chromium). With neither set Playwright
    // resolves its own download, which is what the Debian escape hatch wants.
    channel: reportEnv.REPORT_BROWSER_CHANNEL,
    executablePath: reportEnv.REPORT_BROWSER_EXECUTABLE_PATH,
    args: LAUNCH_ARGS,
    // `page.pdf()` is headless-only — it throws outright in headed mode, so
    // this is not a flag to flip while debugging a blank render.
    headless: true,
  });

  // A crashed or OOM-killed browser leaves a Browser object whose every later
  // call rejects. Dropping the reference here means the NEXT job relaunches
  // transparently instead of every job after the crash failing identically.
  browser.on("disconnected", () => {
    if (instance === browser) instance = null;
  });

  return browser;
}

export async function getBrowser(): Promise<Browser> {
  if (instance?.isConnected()) return instance;
  // Concurrency is 1 today, but a shared in-flight promise costs nothing and
  // stops two callers ever racing two Chromium processes into existence.
  if (!launching) {
    launching = launch()
      .then((b) => {
        instance = b;
        return b;
      })
      .finally(() => {
        launching = null;
      });
  }
  return launching;
}

/**
 * A fresh context per job — no cookie, cache or storage carried from the last
 * report into the next one. Cheap: a context is not a process.
 *
 * The `route` abort is the offline guarantee. The report document is entirely
 * self-contained (inline CSS, hand-written SVG, a data: URI logo at most), so
 * ANY outbound request from it is a bug. Aborting turns a hang — 30 seconds
 * spent resolving a webfont that will never load in a container with no
 * egress — into an immediate render, and it is the backstop behind the
 * data:-URI-only logo policy: even if a `https://` logo reached the payload,
 * the browser inside the worker's Docker network could not fetch it, so it
 * cannot be pointed at http://ollama:11434 or http://api:4000.
 */
export async function newReportContext(): Promise<BrowserContext> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    // Matches the A4 print box closely enough that a chart laid out on screen
    // is the chart that prints; `page.pdf()` re-lays-out at paper size anyway.
    viewport: { width: 1240, height: 1754 },
    deviceScaleFactor: 2,
  });
  context.setDefaultTimeout(reportEnv.REPORT_PDF_TIMEOUT_MS);
  await context.route("**/*", (route) => route.abort());
  return context;
}

/** Called from the SIGTERM handler alongside `stopScheduler()`. Idempotent:
 * a worker that never rendered anything has nothing to close. */
export async function closeBrowser(): Promise<void> {
  const browser = instance;
  instance = null;
  if (browser?.isConnected()) await browser.close().catch(() => {});
}
