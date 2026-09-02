import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { audit } from "@patchpilot/graph";
import { can } from "@patchpilot/shared";
import type { AiChatMessage } from "@patchpilot/ai";
import { config } from "../config.js";
import { requirePermission } from "../auth/rbac.js";
import { loadReachableTenantIds, loadReachableTenants } from "../ai/context.js";
import { runChatTurn } from "../ai/chat.js";
import { summarizePage, SummarizeInputError, type SummarizePage } from "../ai/summarize.js";
import {
  createConversation,
  listConversations,
  getConversation,
  listMessages,
  appendMessages,
  setConversationTitleIfUnset,
  type MessageRecord,
} from "../ai/store.js";

/**
 * AI features (summaries, reports, chatbot) — foundation phase.
 *
 * Status route is the Phase 0 smoke test: proof the Ollama container is
 * wired up end-to-end (config -> network -> model pulled) before anything
 * is built on top of it. Everything below is Phase 1's chat foundation.
 *
 * `AI_FEATURES_ENABLED=false` (the default) short-circuits before ever
 * reaching Ollama, so an operator who hasn't opted in never pays for a
 * container probe on every status check.
 *
 * Every chat route re-validates two things on every call, never just once at
 * conversation creation: that the requesting engineer still owns the
 * conversation, and that its tenant (if any) is still reachable — either can
 * change mid-conversation (tenant loses consent, engineer is disabled).
 */

function toAiChatMessages(records: readonly MessageRecord[]): AiChatMessage[] {
  return records.map((m) => ({
    role: m.role,
    content: m.content,
    toolCalls: m.toolCalls.length ? m.toolCalls.map((tc) => ({ name: tc.name, arguments: tc.args as Record<string, unknown> })) : undefined,
  }));
}

interface OllamaTagsResponse {
  models?: { name: string }[];
}

function writeSse(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requirePermission("ai:use"));

  app.get("/api/ai/status", async () => {
    if (!config.AI_FEATURES_ENABLED) {
      return { enabled: false, model: config.OLLAMA_MODEL, reachable: false, modelPulled: false, detail: "AI_FEATURES_ENABLED is false." };
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.min(config.OLLAMA_REQUEST_TIMEOUT_MS, 5000));
      const res = await fetch(new URL("/api/tags", config.OLLAMA_BASE_URL), { signal: controller.signal });
      clearTimeout(timeout);

      if (!res.ok) {
        return { enabled: true, model: config.OLLAMA_MODEL, reachable: false, modelPulled: false, detail: `Ollama responded HTTP ${res.status}` };
      }

      const body = (await res.json()) as OllamaTagsResponse;
      const modelPulled = (body.models ?? []).some((m) => m.name === config.OLLAMA_MODEL);
      return {
        enabled: true,
        model: config.OLLAMA_MODEL,
        reachable: true,
        modelPulled,
        detail: modelPulled
          ? "Ollama reachable, model pulled."
          : `Ollama reachable, but "${config.OLLAMA_MODEL}" is not pulled yet — run: docker compose exec ollama ollama pull ${config.OLLAMA_MODEL}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "unreachable";
      return { enabled: true, model: config.OLLAMA_MODEL, reachable: false, modelPulled: false, detail: message };
    }
  });

  const SummarizeBody = z.object({
    page: z.enum(["dashboard", "vulnerabilities", "devices", "remediation-history"]),
    /** null/omitted = all reachable tenants — only "dashboard" and
     * "remediation-history" support that; the other two pages require one. */
    tenantId: z.string().min(1).nullable().optional(),
    windowDays: z.number().int().min(1).max(365).optional(),
  });

  app.post<{ Body: z.infer<typeof SummarizeBody> }>("/api/ai/summarize", async (req, reply) => {
    if (!config.AI_FEATURES_ENABLED) return reply.code(503).send({ error: "ai_disabled" });
    if (!can(req.currentUser!.role, "operations:read")) {
      return reply.code(403).send({ error: "forbidden" });
    }

    const parsed = SummarizeBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

    const tenantId = parsed.data.tenantId ?? null;
    const reachableTenantIds = await loadReachableTenantIds();
    if (tenantId && !reachableTenantIds.has(tenantId)) {
      return reply.code(403).send({ error: "tenant_unreachable" });
    }

    try {
      const { summary } = await summarizePage({
        page: parsed.data.page as SummarizePage,
        tenantId,
        windowDays: parsed.data.windowDays,
        reachableTenantIds,
      });

      await audit({
        engineer: req.currentUser!.upn,
        tenantId: tenantId ?? undefined,
        endpoint: "ai:summarize",
        method: "POST",
        action: "ai:summarize",
        resourceType: "ai-conversation",
        summary: `Generated an AI summary of ${parsed.data.page}${tenantId ? "" : " (all tenants)"}`,
        outcome: "success",
        responseStatus: 200,
      });

      return reply.send({ summary });
    } catch (err) {
      if (err instanceof SummarizeInputError) {
        return reply.code(400).send({ error: err.message });
      }
      const message = err instanceof Error ? err.message : "AI summarize failed.";
      return reply.code(502).send({ error: message });
    }
  });

  const CreateConversationBody = z.object({ tenantId: z.string().min(1).nullable().optional() });

  app.post<{ Body: z.infer<typeof CreateConversationBody> }>("/api/ai/conversations", async (req, reply) => {
    if (!config.AI_FEATURES_ENABLED) return reply.code(503).send({ error: "ai_disabled" });
    const parsed = CreateConversationBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

    const tenantId = parsed.data.tenantId ?? null;
    if (tenantId) {
      const reachable = await loadReachableTenantIds();
      if (!reachable.has(tenantId)) return reply.code(403).send({ error: "tenant_unreachable" });
    }

    const conversation = await createConversation(req.currentUser!.upn, tenantId, null);
    return reply.code(201).send(conversation);
  });

  app.get("/api/ai/conversations", async (req, reply) => {
    if (!config.AI_FEATURES_ENABLED) return reply.send([]);
    return listConversations(req.currentUser!.upn);
  });

  app.get<{ Params: { id: string } }>("/api/ai/conversations/:id/messages", async (req, reply) => {
    if (!config.AI_FEATURES_ENABLED) return reply.code(503).send({ error: "ai_disabled" });

    // Ownership is a plain equality check against the free-text UPN column,
    // not a join — same reasoning as every other engineer-attributed row in
    // this schema (see aiConversations.engineer's own comment).
    const conversation = await getConversation(req.params.id);
    if (!conversation || conversation.engineer !== req.currentUser!.upn) {
      return reply.code(404).send({ error: "not_found" });
    }
    return listMessages(conversation.id);
  });

  const PostMessageBody = z.object({ content: z.string().trim().min(1).max(4000) });

  app.post<{ Params: { id: string }; Body: z.infer<typeof PostMessageBody> }>(
    "/api/ai/conversations/:id/messages",
    async (req, reply) => {
      if (!config.AI_FEATURES_ENABLED) return reply.code(503).send({ error: "ai_disabled" });

      const conversation = await getConversation(req.params.id);
      if (!conversation || conversation.engineer !== req.currentUser!.upn) {
        return reply.code(404).send({ error: "not_found" });
      }

      const parsed = PostMessageBody.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

      // Re-checked here, not just at conversation creation: a tenant can lose
      // reachability mid-conversation (consent revoked, GDAP role removed).
      const reachableTenants = await loadReachableTenants();
      const reachableTenantIds = new Set(reachableTenants.map((t) => t.tenantId));
      if (conversation.tenantId && !reachableTenantIds.has(conversation.tenantId)) {
        return reply.code(403).send({ error: "tenant_unreachable" });
      }
      const scope = conversation.tenantId
        ? {
            tenantId: conversation.tenantId,
            displayName: reachableTenants.find((t) => t.tenantId === conversation.tenantId)!.displayName,
          }
        : null;

      const priorRecords = await listMessages(conversation.id);
      const [userRecord] = await appendMessages(conversation.id, [{ role: "user", content: parsed.data.content }]);
      await setConversationTitleIfUnset(conversation.id, parsed.data.content.slice(0, 80));

      const conversationSoFar = [...toAiChatMessages(priorRecords), { role: "user" as const, content: parsed.data.content }];
      const produced = await runChatTurn({ user: req.currentUser!, reachableTenantIds }, conversationSoFar, scope);
      const savedProduced = await appendMessages(conversation.id, produced);

      const toolsCalled = produced.flatMap((m) => m.toolCalls?.map((t) => t.name) ?? []);
      await audit({
        engineer: req.currentUser!.upn,
        tenantId: conversation.tenantId ?? undefined,
        endpoint: `ai:conversations:${conversation.id}:messages`,
        method: "POST",
        action: "ai:chat-message",
        resourceType: "ai-conversation",
        resourceId: conversation.id,
        summary: `Sent a chat message${conversation.tenantId ? "" : " (all tenants)"}`,
        outcome: "success",
        detail: toolsCalled.length ? `Tools called: ${toolsCalled.join(", ")}` : null,
        responseStatus: 200,
      });

      return reply.code(201).send({ userMessage: userRecord, messages: savedProduced });
    },
  );

  /**
   * Streaming counterpart to the route above — same validation, persistence,
   * and audit behavior, but the assistant's text streams to the client as
   * Server-Sent Events instead of arriving as one response once everything is
   * done. Kept as a separate route rather than content-negotiated on the same
   * path so the tested non-streaming route stays untouched.
   *
   * Not `text/event-stream` via EventSource — this is a POST, so the client
   * reads the stream via `fetch` + a manual reader (see apps/web/src/lib/ai.ts).
   * Events: `start` (userMessage persisted), `delta` (text token), `done`
   * (final persisted messages, same shape as the non-streaming route's body),
   * `error` (request failed after streaming began, so it can't become an HTTP
   * error status — the client must check for this event).
   */
  app.post<{ Params: { id: string }; Body: z.infer<typeof PostMessageBody> }>(
    "/api/ai/conversations/:id/messages/stream",
    async (req, reply) => {
      if (!config.AI_FEATURES_ENABLED) return reply.code(503).send({ error: "ai_disabled" });

      const conversation = await getConversation(req.params.id);
      if (!conversation || conversation.engineer !== req.currentUser!.upn) {
        return reply.code(404).send({ error: "not_found" });
      }

      const parsed = PostMessageBody.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

      const reachableTenants = await loadReachableTenants();
      const reachableTenantIds = new Set(reachableTenants.map((t) => t.tenantId));
      if (conversation.tenantId && !reachableTenantIds.has(conversation.tenantId)) {
        return reply.code(403).send({ error: "tenant_unreachable" });
      }
      const scope = conversation.tenantId
        ? {
            tenantId: conversation.tenantId,
            displayName: reachableTenants.find((t) => t.tenantId === conversation.tenantId)!.displayName,
          }
        : null;

      const priorRecords = await listMessages(conversation.id);
      const [userRecord] = await appendMessages(conversation.id, [{ role: "user", content: parsed.data.content }]);
      await setConversationTitleIfUnset(conversation.id, parsed.data.content.slice(0, 80));

      const conversationSoFar = [...toAiChatMessages(priorRecords), { role: "user" as const, content: parsed.data.content }];

      // From here on, errors can't become HTTP status codes — the response
      // headers are already committed to the client as an open SSE stream.
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      writeSse(reply, "start", { userMessage: userRecord });

      try {
        const produced = await runChatTurn(
          { user: req.currentUser!, reachableTenantIds },
          conversationSoFar,
          scope,
          (delta) => writeSse(reply, "delta", { text: delta }),
        );
        const savedProduced = await appendMessages(conversation.id, produced);

        const toolsCalled = produced.flatMap((m) => m.toolCalls?.map((t) => t.name) ?? []);
        await audit({
          engineer: req.currentUser!.upn,
          tenantId: conversation.tenantId ?? undefined,
          endpoint: `ai:conversations:${conversation.id}:messages`,
          method: "POST",
          action: "ai:chat-message",
          resourceType: "ai-conversation",
          resourceId: conversation.id,
          summary: `Sent a chat message${conversation.tenantId ? "" : " (all tenants)"}`,
          outcome: "success",
          detail: toolsCalled.length ? `Tools called: ${toolsCalled.join(", ")}` : null,
          responseStatus: 200,
        });

        writeSse(reply, "done", { userMessage: userRecord, messages: savedProduced });
      } catch (err) {
        const message = err instanceof Error ? err.message : "AI chat failed.";
        writeSse(reply, "error", { error: message });
      } finally {
        reply.raw.end();
      }
    },
  );

  // Report generation used to live here (Phase 4) — retired in favor of
  // /api/reports (apps/api/src/routes/reports.ts), which replaces the
  // BullMQ-return-value result with a durable `reports` row, adds charts,
  // branding and CSV exports, and reopens the feature to readers who only
  // have operations:read. See the reports plan's §6 "Fate of the old
  // surface" for the full rationale. `ai:report-generate` and the
  // "ai-report" resource type stay in the audit vocabulary so historical
  // rows from this route remain filterable and labelled.
}
