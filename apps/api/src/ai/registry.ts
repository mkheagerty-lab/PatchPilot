import type { AiToolSpec } from "@patchpilot/ai";
import { auditSafe } from "@patchpilot/graph";
import { TOOLS } from "./tools.js";
import { ToolError, type ToolContext } from "./context.js";

/** What gets sent to Ollama's `tools` array — name/description/JSON-Schema
 * only, no handler. Regenerated from `TOOLS` so the spec the model sees and
 * the function that actually runs can never drift apart. */
export const TOOL_SPECS: AiToolSpec[] = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  parameters: t.parameters,
}));

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/**
 * The hard registry lookup the whole security design depends on: an unknown
 * tool name is rejected outright, never reflected back into a call. Every
 * outcome — success, a failed zod validation, a permission/tenant refusal
 * thrown as `ToolError`, or an unexpected exception — comes back as a plain
 * JSON-serializable value, so a tool call can never crash the chat turn; it
 * can only ever produce a result the model narrates.
 */
export async function executeTool(name: string, rawArgs: unknown, ctx: ToolContext): Promise<unknown> {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) {
    return { error: `Unknown tool "${name}".` };
  }

  const parsed = tool.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return { error: `Invalid arguments for "${name}": ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }

  try {
    return await tool.run(ctx, parsed.data);
  } catch (err) {
    if (err instanceof ToolError) {
      // The most security-relevant row this feature produces: the model
      // asked for something the requesting engineer's role or tenant
      // reachability doesn't allow, and the tool refused. Fire-and-forget —
      // a denial that fails to log must never block the chat turn from
      // still returning a sensible refusal to the user.
      void auditSafe({
        engineer: ctx.user.upn,
        actorType: "user",
        tenantId: extractTenantId(parsed.data),
        endpoint: `ai:tool:${name}`,
        method: "TOOL",
        action: "ai:tool-call-denied",
        resourceType: "ai-conversation",
        summary: `AI tool "${name}" denied: ${err.message}`,
        outcome: "skipped",
        responseStatus: 403,
      });
      return { error: err.message };
    }
    console.error(`[ai] tool "${name}" threw`, err);
    return { error: "Something went wrong running that tool." };
  }
}

function extractTenantId(args: unknown): string | undefined {
  if (args && typeof args === "object" && "tenantId" in args) {
    const v = (args as { tenantId?: unknown }).tenantId;
    return typeof v === "string" ? v : undefined;
  }
  return undefined;
}
