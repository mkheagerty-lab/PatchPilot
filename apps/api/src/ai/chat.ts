import { OllamaClient, type AiChatMessage } from "@patchpilot/ai";
import { config } from "../config.js";
import { TOOL_SPECS, executeTool } from "./registry.js";
import { SYSTEM_PROMPT } from "./prompts.js";
import type { ToolContext } from "./context.js";

/** Bounds a single turn's tool-call loop. A well-behaved model finishes in
 * 1-2 rounds (one round to call a tool, one to narrate the result); this is
 * a backstop against a model that keeps calling tools instead of answering,
 * not a number tuned for the common case. */
const MAX_TOOL_ROUNDS = 4;

/** One produced message, shaped for direct persistence via store.ts —
 * `toolCalls` is only ever populated on an "assistant" message, matching
 * `aiMessages.toolCalls`'s contract. */
export interface ChatTurnMessage {
  role: AiChatMessage["role"];
  content: string;
  toolCalls?: { name: string; args: unknown }[];
}

/**
 * `llama3.1:8b` doesn't reliably use Ollama's native tool-calling on every
 * round of a multi-step turn — observed in practice: instead of populating
 * `message.toolCalls`, it sometimes writes its intended call as prose plus a
 * hand-typed JSON blob straight into `message.content` (e.g. `Let's call
 * get_high_priority_findings to get more details: {"name": "...",
 * "parameters": {...}}`). Left alone, that scratchpad text — plus whatever
 * planning prose surrounds it — would be persisted and shown to the user
 * verbatim, which is exactly the "leaks tool names and JSON" bug this guards
 * against. Since it's shaped just like a real tool call, we run it through
 * the same `executeTool` a well-formed call would hit (including its "unknown
 * tool" handling for a hallucinated name) rather than showing it raw.
 */
function extractLeakedToolCall(content: string): { name: string; arguments: Record<string, unknown> } | null {
  for (let start = content.indexOf("{"); start !== -1; start = content.indexOf("{", start + 1)) {
    let depth = 0;
    for (let i = start; i < content.length; i++) {
      if (content[i] === "{") depth++;
      else if (content[i] === "}") {
        depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(content.slice(start, i + 1));
            const args = parsed?.parameters ?? parsed?.arguments;
            if (typeof parsed?.name === "string" && args && typeof args === "object") {
              return { name: parsed.name, arguments: args };
            }
          } catch {
            // Not valid JSON at this span — fall through and try the next "{".
          }
          break;
        }
      }
    }
  }
  return null;
}

let sharedClient: OllamaClient | null = null;
/** Shared across every AI entry point (chat, summarize) — one process, one
 * client, same config; there's nothing per-call to isolate. */
export function getOllamaClient(): OllamaClient {
  if (!sharedClient) {
    sharedClient = new OllamaClient({
      baseUrl: config.OLLAMA_BASE_URL,
      model: config.OLLAMA_MODEL,
      requestTimeoutMs: config.OLLAMA_REQUEST_TIMEOUT_MS,
    });
  }
  return sharedClient;
}

/** The conversation's tenant scope, resolved once by the route handler and
 * handed in — never re-derived here. `null` means "all reachable tenants". */
export interface ChatScope {
  tenantId: string;
  displayName: string;
}

function scopeSystemMessage(scope: ChatScope | null): AiChatMessage {
  const content = scope
    ? `Current tenant scope for this conversation: "${scope.displayName}" (tenantId: ${scope.tenantId}). When the user says "this tenant" or doesn't name a tenant, use this tenantId for any tool call that needs one — never invent or guess a tenant ID.`
    : `Current tenant scope for this conversation: all tenants the engineer can reach (no single tenant selected). If a tool call needs one tenantId, call list_reachable_tenants first to resolve which tenant the user means — never invent or guess a tenant ID.`;
  return { role: "system", content };
}

/**
 * Runs one full turn: the prior conversation (already including the new
 * user message) in, the sequence of new messages produced out — assistant
 * text, any tool calls with their results, ending in a final plain-text
 * assistant reply. This function never touches the database; the route
 * handler persists whatever it returns.
 *
 * `onDelta`, when given, streams every content token as it arrives from
 * Ollama — including on interim tool-calling rounds, where content is
 * typically empty anyway. The route handler is what decides whether to wire
 * this to an SSE response; this function stays transport-agnostic.
 *
 * The message pushed to `produced` for a tool-calling round never includes
 * `message.content` — only the tool badges — even though `onDelta` may have
 * already streamed some of that round's raw content live. That's the model's
 * own planning scratchpad, not an answer, and isn't fit to persist or
 * redisplay once the round is known to be a tool call rather than a final
 * reply.
 */
export async function runChatTurn(
  ctx: ToolContext,
  priorMessages: AiChatMessage[],
  scope: ChatScope | null,
  onDelta?: (delta: string) => void,
): Promise<ChatTurnMessage[]> {
  const ollama = getOllamaClient();
  const conversation: AiChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    scopeSystemMessage(scope),
    ...priorMessages,
  ];
  const produced: ChatTurnMessage[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const { message } = await ollama.chatStream({ messages: conversation, tools: TOOL_SPECS }, onDelta ?? (() => {}));
    conversation.push(message);

    const realCalls = message.toolCalls?.length ? message.toolCalls : null;
    const leaked = realCalls ? null : extractLeakedToolCall(message.content);

    if (!realCalls && !leaked) {
      produced.push({ role: "assistant", content: message.content });
      return produced;
    }

    const calls = (realCalls ?? [leaked!]).map((tc) => ({ name: tc.name, args: tc.arguments }));
    produced.push({ role: "assistant", content: "", toolCalls: calls });

    for (const call of calls) {
      const resultPayload = await executeTool(call.name, call.args, ctx);
      const content = JSON.stringify(resultPayload);
      conversation.push({ role: "tool", content });
      produced.push({ role: "tool", content });
    }
  }

  produced.push({
    role: "assistant",
    content: "I wasn't able to finish gathering that information within this turn — try narrowing the question.",
  });
  return produced;
}
