/**
 * Wire-level shapes for a single Ollama `/api/chat` turn — deliberately
 * app-agnostic. This package knows nothing about PatchPilot's domain (tenants,
 * findings, jobs); that lives in `apps/api/src/ai`, which is what actually
 * defines and executes tools. Keeping the split this way is what lets this
 * package be audited in isolation: read `client.ts` once and you've confirmed
 * every request this process can ever send an LLM.
 */

export type AiChatRole = "system" | "user" | "assistant" | "tool";

export interface AiToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface AiChatMessage {
  role: AiChatRole;
  content: string;
  /** Only ever set on an "assistant" message. */
  toolCalls?: AiToolCall[];
}

/** One entry of Ollama's `tools` array — JSON Schema `parameters`, same shape
 * OpenAI-style function calling uses (Ollama's native tool support mirrors it). */
export interface AiToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AiChatRequest {
  messages: AiChatMessage[];
  tools?: AiToolSpec[];
}

export interface AiChatResult {
  message: AiChatMessage;
}
