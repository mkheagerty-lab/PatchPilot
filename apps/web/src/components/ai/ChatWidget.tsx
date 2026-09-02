import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEngineer } from "../../lib/auth";
import { useTenant } from "../../lib/tenant";
import { aiApi, type AiConversation, type AiMessage } from "../../lib/ai";
import { ApiError } from "../../lib/api";

/**
 * Persistent chat affordance, mounted once in App.tsx's Layout (gated by
 * `useCan("ai:use")` there) so it survives route changes. Hidden entirely —
 * not just disabled — when AI_FEATURES_ENABLED is off, per the plan's "every
 * AI affordance disappears when the operator hasn't opted in" rule.
 */
export function ChatWidget() {
  const engineer = useEngineer();
  const { activeTenantId, activeTenant, isAllTenants } = useTenant();
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"chat" | "history">("chat");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const status = useQuery({
    queryKey: ["ai", "status"],
    queryFn: aiApi.status,
    staleTime: 60_000,
  });

  const conversations = useQuery({
    queryKey: ["ai", "conversations"],
    queryFn: aiApi.listConversations,
    enabled: open && status.data?.enabled === true,
  });

  const messages = useQuery({
    queryKey: ["ai", "messages", conversationId],
    queryFn: () => aiApi.listMessages(conversationId!),
    enabled: open && conversationId != null,
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.data, sending, streamingText]);

  if (!status.data?.enabled) return null;

  // Cross-tenant chat scope when "All Tenants" is selected — mirrors every
  // other page's "no tenantId param = unfiltered" convention.
  const scopeTenantId = isAllTenants ? null : activeTenantId;
  const scopeLabel = isAllTenants ? "All Tenants" : activeTenant?.displayName ?? "—";

  async function ensureConversation(): Promise<string> {
    if (conversationId) return conversationId;
    const conv = await aiApi.createConversation(scopeTenantId);
    setConversationId(conv.id);
    queryClient.setQueryData<AiConversation[]>(["ai", "conversations"], (old) =>
      old ? [conv, ...old] : [conv],
    );
    queryClient.setQueryData<AiMessage[]>(["ai", "messages", conv.id], []);
    return conv.id;
  }

  async function handleSend() {
    const content = draft.trim();
    if (!content || sending) return;
    setError(null);
    setDraft("");
    setSending(true);
    setStreamingText("");
    try {
      const id = await ensureConversation();
      const optimistic: AiMessage = {
        id: `optimistic-${Date.now()}`,
        conversationId: id,
        role: "user",
        content,
        toolCalls: [],
        createdAt: new Date().toISOString(),
      };
      queryClient.setQueryData<AiMessage[]>(["ai", "messages", id], (old) => [
        ...(old ?? []),
        optimistic,
      ]);

      let streamError: string | null = null;
      await aiApi.streamMessage(id, content, {
        onDelta: (text) => setStreamingText((prev) => prev + text),
        onDone: (result) => {
          queryClient.setQueryData<AiMessage[]>(["ai", "messages", id], (old) => [
            ...(old ?? []).filter((m) => m.id !== optimistic.id),
            result.userMessage,
            ...result.messages,
          ]);
          void queryClient.invalidateQueries({ queryKey: ["ai", "conversations"] });
        },
        onError: (message) => {
          streamError = message;
        },
      });
      if (streamError) setError(streamError);
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : "Couldn't reach the AI assistant.";
      setError(message);
    } finally {
      setSending(false);
      setStreamingText("");
    }
  }

  function openHistoryConversation(conv: AiConversation) {
    setConversationId(conv.id);
    setView("chat");
  }

  function startNewChat() {
    setConversationId(null);
    setError(null);
    setView("chat");
  }

  const visibleMessages = (messages.data ?? []).filter(
    (m) => m.role === "user" || m.role === "assistant",
  );

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end print:hidden">
      {open && (
        <div className="mb-3 flex h-[32rem] w-96 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl">
          <div className="flex items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-slate-900">PatchPilot Assistant</div>
              <div className="truncate text-xs text-slate-500">
                Scope: {scopeLabel}
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={startNewChat}
                title="New chat"
                className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
              >
                <PlusIcon />
              </button>
              <button
                type="button"
                onClick={() => setView(view === "chat" ? "history" : "chat")}
                title="Chat history"
                className={`rounded-md p-1.5 transition-colors hover:bg-slate-100 hover:text-slate-700 ${
                  view === "history" ? "bg-slate-100 text-slate-700" : "text-slate-400"
                }`}
              >
                <HistoryIcon />
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                title="Close"
                className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
              >
                <CloseIcon />
              </button>
            </div>
          </div>

          {view === "history" ? (
            <div className="flex-1 overflow-y-auto">
              {conversations.isLoading && (
                <p className="p-4 text-sm text-slate-400">Loading…</p>
              )}
              {conversations.data?.length === 0 && (
                <p className="p-4 text-sm text-slate-400">No conversations yet.</p>
              )}
              {conversations.data?.map((conv) => (
                <button
                  key={conv.id}
                  type="button"
                  onClick={() => openHistoryConversation(conv)}
                  className={`block w-full border-b border-slate-100 px-4 py-3 text-left transition-colors hover:bg-slate-50 ${
                    conv.id === conversationId ? "bg-slate-50" : ""
                  }`}
                >
                  <div className="truncate text-sm font-medium text-slate-800">
                    {conv.title ?? "New conversation"}
                  </div>
                  <div className="mt-0.5 text-xs text-slate-400">
                    {conv.tenantId ? conv.tenantId : "All tenants"} ·{" "}
                    {new Date(conv.updatedAt).toLocaleString()}
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <>
              <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
                {visibleMessages.length === 0 && !sending && (
                  <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-500">
                    Ask about vulnerabilities, remediation history, jobs, or the script
                    catalog for {scopeLabel}. I only see what your role and tenant access
                    already allow.
                  </div>
                )}
                {visibleMessages.map((m) => (
                  <ChatBubble key={m.id} message={m} engineerName={engineer.displayName} />
                ))}
                {sending && (
                  <div className="flex justify-start">
                    <div
                      className={`whitespace-pre-wrap rounded-lg bg-slate-100 px-3 py-2 text-sm ${
                        streamingText ? "text-slate-800" : "text-slate-400"
                      }`}
                    >
                      {streamingText || "Thinking…"}
                    </div>
                  </div>
                )}
              </div>

              {error && (
                <div className="border-t border-rose-100 bg-rose-50 px-4 py-2 text-xs text-rose-600">
                  {error}
                </div>
              )}

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleSend();
                }}
                className="flex items-end gap-2 border-t border-slate-200 p-3"
              >
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void handleSend();
                    }
                  }}
                  rows={1}
                  placeholder="Ask a question…"
                  className="max-h-24 flex-1 resize-none rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={sending || draft.trim().length === 0}
                  className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  Send
                </button>
              </form>
            </>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Close AI assistant" : "Open AI assistant"}
        className="flex h-14 w-14 items-center justify-center rounded-full bg-slate-900 text-white shadow-lg transition-colors hover:bg-slate-700"
      >
        {open ? <CloseIcon className="h-6 w-6" /> : <ChatIcon className="h-6 w-6" />}
      </button>
    </div>
  );
}

function ChatBubble({
  message,
  engineerName,
}: {
  message: AiMessage;
  engineerName: string;
}) {
  const isUser = message.role === "user";
  const toolNames = message.toolCalls.map((t) => t.name);
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className="max-w-[85%]">
        <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-400">
          {isUser ? engineerName : "Assistant"}
        </div>
        {toolNames.length > 0 && (
          <div className="mb-1 flex flex-wrap gap-1">
            {toolNames.map((name, i) => (
              <span
                key={`${name}-${i}`}
                className="rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-medium text-sky-600"
              >
                {name}
              </span>
            ))}
          </div>
        )}
        {message.content && (
          <div
            className={`whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
              isUser ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-800"
            }`}
          >
            {message.content}
          </div>
        )}
      </div>
    </div>
  );
}

function ChatIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className={className} aria-hidden>
      <path
        fillRule="evenodd"
        d="M2 4.75A2.75 2.75 0 0 1 4.75 2h10.5A2.75 2.75 0 0 1 18 4.75v7.5A2.75 2.75 0 0 1 15.25 15H10l-3.72 3.03A.75.75 0 0 1 5 17.44V15H4.75A2.75 2.75 0 0 1 2 12.25v-7.5Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function CloseIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className={className} aria-hidden>
      <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden>
      <path d="M10 3a.75.75 0 0 1 .75.75v5.5h5.5a.75.75 0 0 1 0 1.5h-5.5v5.5a.75.75 0 0 1-1.5 0v-5.5h-5.5a.75.75 0 0 1 0-1.5h5.5v-5.5A.75.75 0 0 1 10 3Z" />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden>
      <path
        fillRule="evenodd"
        d="M10 2a8 8 0 1 0 8 8 .75.75 0 0 0-1.5 0 6.5 6.5 0 1 1-6.5-6.5c1.62 0 3.08.66 4.13 1.72l-1.68 1.68a.5.5 0 0 0 .35.85h4a.5.5 0 0 0 .5-.5v-4a.5.5 0 0 0-.85-.35l-1.27 1.27A7.98 7.98 0 0 0 10 2Zm.75 4.25a.75.75 0 0 0-1.5 0V10c0 .2.08.39.22.53l2.5 2.5a.75.75 0 0 0 1.06-1.06l-2.28-2.28V6.25Z"
        clipRule="evenodd"
      />
    </svg>
  );
}
