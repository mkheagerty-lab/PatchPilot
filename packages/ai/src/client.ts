import type { AiChatMessage, AiChatRequest, AiChatResult } from "./types.js";

export interface OllamaClientOptions {
  baseUrl: string;
  model: string;
  requestTimeoutMs: number;
}

interface OllamaApiToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

interface OllamaApiMessage {
  role: string;
  content: string;
  tool_calls?: OllamaApiToolCall[];
}

interface OllamaApiChatResponse {
  message?: OllamaApiMessage;
  error?: string;
}

/**
 * A hand-rolled wrapper around Ollama's native `/api/chat` — no SDK. The
 * `fetch` call below is the ONLY outbound network call this package makes,
 * and it always targets `options.baseUrl` (the self-hosted `ollama` compose
 * service, never a third-party endpoint). That single-call-site property is
 * what makes "no web access" a structural, auditable fact rather than a
 * system-prompt request the model could ignore.
 */
export class OllamaClient {
  constructor(private readonly options: OllamaClientOptions) {}

  async chat(request: AiChatRequest): Promise<AiChatResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);

    try {
      const res = await fetch(new URL("/api/chat", this.options.baseUrl), {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.options.model,
          stream: false,
          messages: request.messages.map(toApiMessage),
          ...(request.tools?.length
            ? { tools: request.tools.map((t) => ({ type: "function", function: t })) }
            : {}),
        }),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Ollama responded HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
      }

      const body = (await res.json()) as OllamaApiChatResponse;
      if (!body.message) {
        throw new Error(body.error ?? "Ollama returned no message");
      }
      return { message: fromApiMessage(body.message) };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Streaming counterpart to `chat()` — same single `fetch` call site, same
   * request shape, just `stream: true`. Ollama's streaming response is NDJSON
   * (one JSON object per line); each line carries a `message.content` delta
   * to append, and tool calls (when the model emits any) arrive whole on one
   * line rather than token-by-token. `onDelta` fires for every non-empty
   * content delta as it arrives; the returned promise resolves once with the
   * fully assembled message, same shape `chat()` returns.
   */
  async chatStream(request: AiChatRequest, onDelta: (delta: string) => void): Promise<AiChatResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);

    try {
      const res = await fetch(new URL("/api/chat", this.options.baseUrl), {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.options.model,
          stream: true,
          messages: request.messages.map(toApiMessage),
          ...(request.tools?.length
            ? { tools: request.tools.map((t) => ({ type: "function", function: t })) }
            : {}),
        }),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Ollama responded HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
      }
      if (!res.body) {
        throw new Error("Ollama returned no response body for a streaming chat request");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assembled: OllamaApiMessage | null = null;

      const consumeLine = (line: string) => {
        if (!line) return;
        const chunk = JSON.parse(line) as OllamaApiChatResponse;
        if (chunk.error) throw new Error(chunk.error);
        if (!chunk.message) return;
        assembled = {
          role: chunk.message.role || assembled?.role || "assistant",
          content: (assembled?.content ?? "") + (chunk.message.content ?? ""),
          tool_calls: chunk.message.tool_calls ?? assembled?.tool_calls,
        };
        if (chunk.message.content) onDelta(chunk.message.content);
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
          consumeLine(buffer.slice(0, newlineIndex).trim());
          buffer = buffer.slice(newlineIndex + 1);
        }
      }
      consumeLine(buffer.trim());

      if (!assembled) {
        throw new Error("Ollama returned no message");
      }
      return { message: fromApiMessage(assembled) };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function toApiMessage(m: AiChatMessage): OllamaApiMessage {
  return {
    role: m.role,
    content: m.content,
    ...(m.toolCalls?.length
      ? {
          tool_calls: m.toolCalls.map((tc) => ({
            function: { name: tc.name, arguments: tc.arguments },
          })),
        }
      : {}),
  };
}

function fromApiMessage(m: OllamaApiMessage): AiChatMessage {
  const role: AiChatMessage["role"] =
    m.role === "user" || m.role === "assistant" || m.role === "tool" || m.role === "system"
      ? m.role
      : "assistant";
  return {
    role,
    content: m.content ?? "",
    toolCalls: m.tool_calls?.map((tc) => ({
      name: tc.function.name,
      arguments: tc.function.arguments ?? {},
    })),
  };
}
