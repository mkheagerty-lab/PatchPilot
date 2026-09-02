import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import { config } from "../config.js";
import type { ChatTurnMessage } from "./chat.js";

/**
 * Persistence for AI conversations/messages. Mirrors the DEMO_MODE split
 * used everywhere else in this app (jobs.ts's `demoJobLog`,
 * packages/graph/audit.ts's `demoAudits`): production reads/writes
 * `ai_conversations`/`ai_messages`, DEMO_MODE keeps a bounded, newest-first
 * in-memory list local to this module so the chat widget is fully clickable
 * with zero infra dependencies. Unlike audit/jobs, there's no seed data —
 * a demo session's chat history starts empty, same as a brand-new deployment's.
 */

export interface ConversationSummary {
  id: string;
  engineer: string;
  tenantId: string | null;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  toolCalls: { name: string; args: unknown }[];
  createdAt: string;
}

const MAX_DEMO_CONVERSATIONS = 200;
const MAX_DEMO_MESSAGES = 4_000;

const demoConversations: ConversationSummary[] = [];
const demoMessages: MessageRecord[] = [];

function newId(): string {
  return randomUUID();
}

export async function createConversation(
  engineer: string,
  tenantId: string | null,
  title: string | null,
): Promise<ConversationSummary> {
  const now = new Date().toISOString();
  const record: ConversationSummary = { id: newId(), engineer, tenantId, title, createdAt: now, updatedAt: now };

  if (config.DEMO_MODE) {
    demoConversations.unshift(record);
    if (demoConversations.length > MAX_DEMO_CONVERSATIONS) demoConversations.length = MAX_DEMO_CONVERSATIONS;
    return record;
  }

  const [row] = await db
    .insert(tables.aiConversations)
    .values({ id: record.id, engineer, tenantId, title })
    .returning();
  return rowToConversation(row!);
}

/** Newest-first, excluding archived — same soft-hide contract as jobs/scripts. */
export async function listConversations(engineer: string): Promise<ConversationSummary[]> {
  if (config.DEMO_MODE) {
    return demoConversations.filter((c) => c.engineer === engineer);
  }
  const rows = await db
    .select()
    .from(tables.aiConversations)
    .where(and(eq(tables.aiConversations.engineer, engineer), isNull(tables.aiConversations.archivedAt)))
    .orderBy(desc(tables.aiConversations.updatedAt));
  return rows.map(rowToConversation);
}

export async function getConversation(id: string): Promise<ConversationSummary | null> {
  if (config.DEMO_MODE) {
    return demoConversations.find((c) => c.id === id) ?? null;
  }
  const [row] = await db.select().from(tables.aiConversations).where(eq(tables.aiConversations.id, id)).limit(1);
  return row ? rowToConversation(row) : null;
}

export async function listMessages(conversationId: string): Promise<MessageRecord[]> {
  if (config.DEMO_MODE) {
    return demoMessages.filter((m) => m.conversationId === conversationId);
  }
  const rows = await db
    .select()
    .from(tables.aiMessages)
    .where(eq(tables.aiMessages.conversationId, conversationId))
    .orderBy(asc(tables.aiMessages.createdAt));
  return rows.map(rowToMessage);
}

/** Appends messages and bumps the conversation's `updatedAt` in one call —
 * every write path (a new user message, the assistant/tool messages a turn
 * produces) needs both, so keeping them together rules out the two drifting. */
export async function appendMessages(
  conversationId: string,
  messages: ChatTurnMessage[],
): Promise<MessageRecord[]> {
  const now = new Date().toISOString();

  if (config.DEMO_MODE) {
    const records = messages.map((m) => ({
      id: newId(),
      conversationId,
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls ?? [],
      createdAt: now,
    }));
    demoMessages.push(...records);
    if (demoMessages.length > MAX_DEMO_MESSAGES) demoMessages.splice(0, demoMessages.length - MAX_DEMO_MESSAGES);
    const conv = demoConversations.find((c) => c.id === conversationId);
    if (conv) conv.updatedAt = now;
    return records;
  }

  const rows = await db
    .insert(tables.aiMessages)
    .values(
      messages.map((m) => ({
        conversationId,
        role: m.role,
        content: m.content,
        toolCalls: m.toolCalls ?? [],
      })),
    )
    .returning();
  await db.update(tables.aiConversations).set({ updatedAt: new Date() }).where(eq(tables.aiConversations.id, conversationId));
  return rows.map(rowToMessage);
}

/** Sets the conversation's title once, from its first user message — called
 * lazily by the route layer rather than at creation, since the title isn't
 * known until there's something to summarize. */
export async function setConversationTitleIfUnset(id: string, title: string): Promise<void> {
  if (config.DEMO_MODE) {
    const conv = demoConversations.find((c) => c.id === id);
    if (conv && !conv.title) conv.title = title;
    return;
  }
  await db
    .update(tables.aiConversations)
    .set({ title })
    .where(and(eq(tables.aiConversations.id, id), isNull(tables.aiConversations.title)));
}

function rowToConversation(row: typeof tables.aiConversations.$inferSelect): ConversationSummary {
  return {
    id: row.id,
    engineer: row.engineer,
    tenantId: row.tenantId,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToMessage(row: typeof tables.aiMessages.$inferSelect): MessageRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    content: row.content,
    toolCalls: row.toolCalls,
    createdAt: row.createdAt.toISOString(),
  };
}
