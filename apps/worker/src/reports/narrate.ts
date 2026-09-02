/**
 * AI narration for one report section.
 *
 * Ported from the retired `ai-report-worker.ts` (see S10), generalized from
 * two hardcoded sections to any `ReportSectionDef` the registry declares —
 * the prompt was already report-type-agnostic, it just needed a title and a
 * JSON blob. `factCheckSection`, which used to live alongside this, moved to
 * `packages/shared/src/reports.ts` instead: it's pure string work with no
 * Ollama dependency, and putting it where `apps/worker` has no vitest today
 * would have left the feature's highest-value invariant untested.
 */
import { OllamaClient } from "@patchpilot/ai";
import { reportEnv } from "./env.js";

const REPORT_SECTION_SYSTEM_PROMPT = `You write one section of an MSP vulnerability-management report for a named customer, to be read by that customer or by the MSP engineer presenting it to them. You will be given the section's title and one JSON object — the exact data that section covers — and nothing else.

Rules:
- Every number, name, and date you state must come directly from the JSON. Never round, estimate, extrapolate, or state a figure not present in the JSON.
- Do not mention CVEs, tenants, or facts absent from the JSON — you have no other source of information and no internet access.
- Never claim there are "no", "zero", or "none" of something unless the matching JSON field is actually 0 or empty. Before writing a sentence like "there are no X" or "no open Y", find the specific field for X/Y in the JSON and check its value — if it is non-zero, state that number instead of denying it exists.
- Output PLAIN TEXT ONLY: one or two short paragraphs, ordinary prose, no blank line between them. Do not use Markdown formatting of any kind — no "#" headers, no "**bold**", no "-" or numbered lists. If you catch yourself starting a line with "#", "-", "*", or a digit followed by ".", stop and rewrite it as a sentence instead.
- Write for a customer audience: professional, factual, no internal jargon (don't say "SLA breach", say what it means; don't say "winget-remediable").
- Lead with the most important fact for that section.
- If the JSON shows a healthy/quiet state, say so plainly rather than manufacturing urgency.`;

let sharedClient: OllamaClient | null = null;
function getOllamaClient(): OllamaClient {
  if (!sharedClient) {
    sharedClient = new OllamaClient({
      baseUrl: reportEnv.OLLAMA_BASE_URL,
      model: reportEnv.OLLAMA_MODEL,
      requestTimeoutMs: reportEnv.OLLAMA_REQUEST_TIMEOUT_MS,
    });
  }
  return sharedClient;
}

/** Throws on any Ollama failure (unreachable, timeout, model error) — the
 * caller (`worker.ts`) is what decides a thrown error means "degrade this
 * whole report to captions", not this function. */
export async function narrateSection(title: string, facts: unknown): Promise<string> {
  const ollama = getOllamaClient();
  const { message } = await ollama.chat({
    messages: [
      { role: "system", content: REPORT_SECTION_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Section: ${title}\nData (JSON — the only source of truth for any number or name you state):\n${JSON.stringify(facts)}`,
      },
    ],
  });
  return message.content.trim();
}
