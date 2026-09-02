/**
 * Turns a `ReportRenderInput` into PDF bytes.
 *
 * The one function in this feature that actually needs Chromium — everything
 * `template.ts` and `charts.ts` produce is plain strings, checked without a
 * browser. This is where those strings meet `page.pdf()`.
 */
import { reportEnv } from "./env.js";
import { newReportContext } from "./browser.js";
import { renderFooterTemplate, renderHeaderTemplate, renderReportHtml, type ReportRenderInput } from "./template.js";

export interface RenderedReport {
  pdf: Buffer;
}

/** Thrown when `page.pdf()` itself runs past `REPORT_PDF_TIMEOUT_MS`. */
export class ReportRenderTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`page.pdf() did not finish within ${timeoutMs}ms`);
    this.name = "ReportRenderTimeoutError";
  }
}

/**
 * `context.setDefaultTimeout` bounds Playwright *actions* — click, fill,
 * waitForSelector — but `page.pdf()` is a direct CDP call with no `timeout`
 * option and is not subject to that default. Left unguarded, a wedged print
 * (observed upstream on documents holding certain SVG shapes) hangs forever,
 * which is exactly the failure `REPORT_JOB_TIMEOUT_MS` in `worker.ts` exists to
 * catch — but catching it there means the whole job, browser context included,
 * outlives its usefulness. Racing here means the timeout fires at the layer
 * that actually knows what's stuck.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Thrown when a finished PDF exceeds `REPORT_MAX_BYTES` — a runaway, not the
 * common case. A typical branded report is 150-600 KB; this only fires when
 * something is actually wrong (an unbounded fact array that slipped past the
 * api's caps, for instance). */
export class ReportTooLargeError extends Error {
  constructor(public readonly bytes: number, public readonly limit: number) {
    super(`Rendered report is ${bytes} bytes, over the ${limit}-byte limit`);
    this.name = "ReportTooLargeError";
  }
}

/**
 * Renders one report end to end: fresh context, set the HTML, print to PDF,
 * close the context. The context (not the browser) is what's disposed per
 * job — see `browser.ts` for why a whole Chromium process survives across jobs.
 */
export async function renderPdf(input: ReportRenderInput): Promise<RenderedReport> {
  const html = renderReportHtml(input);
  const context = await newReportContext();
  try {
    const page = await context.newPage();
    // `load` rather than `networkidle`: the document fetches nothing (every
    // request is aborted by the context's route handler), so waiting for
    // network idle would just wait out `networkidle`'s quiet-period timer for
    // no reason. `load` fires the moment the inline content has parsed.
    await page.setContent(html, { waitUntil: "load", timeout: reportEnv.REPORT_PDF_TIMEOUT_MS });

    const pdf = await withTimeout(
      page.pdf({
        format: "A4",
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: renderHeaderTemplate(input),
        footerTemplate: renderFooterTemplate(input),
        margin: { top: "18mm", bottom: "20mm", left: "14mm", right: "14mm" },
      }),
      reportEnv.REPORT_PDF_TIMEOUT_MS,
      () => new ReportRenderTimeoutError(reportEnv.REPORT_PDF_TIMEOUT_MS),
    );

    if (pdf.length > reportEnv.REPORT_MAX_BYTES) {
      throw new ReportTooLargeError(pdf.length, reportEnv.REPORT_MAX_BYTES);
    }

    return { pdf };
  } finally {
    // The context, not the browser — see newReportContext's doc comment.
    // Closing it also closes every page opened on it.
    await context.close().catch(() => {});
  }
}
