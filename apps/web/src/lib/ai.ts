// Client for the AI chat foundation (apps/api/src/routes/ai.ts). Mirrors
// lib/api.ts conventions — thin typed wrappers over the shared `api` fetch
// client, no state of its own.

import { api, ApiError } from "./api";

export type AiChatRole = "user" | "assistant" | "tool" | "system";

export interface AiToolCallRecord {
  name: string;
  args: unknown;
}

export interface AiMessage {
  id: string;
  conversationId: string;
  role: AiChatRole;
  content: string;
  toolCalls: AiToolCallRecord[];
  createdAt: string;
}

export interface AiConversation {
  id: string;
  engineer: string;
  /** Null = cross-tenant scope ("All Tenants" was active when this was created). */
  tenantId: string | null;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Phase 0 smoke-test shape — GET /api/ai/status. */
export interface AiStatus {
  enabled: boolean;
  model: string;
  reachable: boolean;
  modelPulled: boolean;
  detail: string;
}

/** Mirrors apps/api/src/ai/summarize.ts's SummarizePage. */
export type SummarizePage = "dashboard" | "vulnerabilities" | "devices" | "remediation-history";

export interface SummarizeRequest {
  page: SummarizePage;
  /** null = all reachable tenants — only "dashboard" and "remediation-history" support this. */
  tenantId: string | null;
  windowDays?: number;
}

export interface SummarizeResult {
  summary: string;
}

export interface PostMessageResult {
  userMessage: AiMessage;
  messages: AiMessage[];
}

export interface StreamMessageEvents {
  onStart?: (userMessage: AiMessage) => void;
  onDelta?: (text: string) => void;
  onDone?: (result: PostMessageResult) => void;
  /** The stream opened but the turn failed partway through — response headers
   * are already committed at that point, so this can't be an HTTP error status. */
  onError?: (message: string) => void;
}

/**
 * Parses one Server-Sent Events frame ("event: x\ndata: y\n\n") into its
 * event name + JSON-parsed data. Returns null for a blank frame (the final
 * flush at stream end, or stray keep-alive whitespace).
 */
function parseSseFrame(raw: string): { event: string; data: unknown } | null {
  const lines = raw.split("\n");
  let event = "message";
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  return { event, data: JSON.parse(dataLines.join("\n")) };
}

/**
 * Streaming counterpart to `postMessage` — reads the SSE response from
 * POST .../messages/stream as it arrives and dispatches to the matching
 * callback. Not EventSource (that's GET-only); a plain `fetch` + manual
 * reader, same `credentials: "same-origin"` convention as the rest of this
 * client. Resolves once the stream ends (after `done` or `error`).
 */
async function streamMessage(
  conversationId: string,
  content: string,
  events: StreamMessageEvents,
): Promise<void> {
  const res = await fetch(`/api/ai/conversations/${conversationId}/messages/stream`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });

  if (!res.ok || !res.body) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      message = body.message ?? body.error ?? message;
    } catch {
      // non-JSON error body; keep statusText
    }
    throw new ApiError(res.status, message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const dispatch = (raw: string) => {
    const frame = parseSseFrame(raw);
    if (!frame) return;
    if (frame.event === "start") events.onStart?.((frame.data as { userMessage: AiMessage }).userMessage);
    else if (frame.event === "delta") events.onDelta?.((frame.data as { text: string }).text);
    else if (frame.event === "done") events.onDone?.(frame.data as PostMessageResult);
    else if (frame.event === "error") events.onError?.((frame.data as { error: string }).error);
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      dispatch(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
    }
  }
  if (buffer.trim()) dispatch(buffer);
}

export const aiApi = {
  status: () => api.get<AiStatus>("/api/ai/status"),
  summarize: (req: SummarizeRequest) => api.post<SummarizeResult>("/api/ai/summarize", req),
  listConversations: () => api.get<AiConversation[]>("/api/ai/conversations"),
  createConversation: (tenantId: string | null) =>
    api.post<AiConversation>("/api/ai/conversations", { tenantId }),
  listMessages: (conversationId: string) =>
    api.get<AiMessage[]>(`/api/ai/conversations/${conversationId}/messages`),
  postMessage: (conversationId: string, content: string) =>
    api.post<PostMessageResult>(`/api/ai/conversations/${conversationId}/messages`, { content }),
  streamMessage,
};
