import { and, eq } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import { decrypt } from "@patchpilot/graph";
import { configureAlerting, type AlertConfig } from "@patchpilot/shared/alerting";

interface SmtpSettingsStored {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  passEncrypted: string | null;
  secure: boolean;
  from: string;
}

/**
 * Worker-side twin of apps/api/src/alerting-config.ts — same DB-backed
 * "smtp" settings row and opted-in engineer list, no DEMO_MODE branch
 * because the worker always talks to real Postgres (see index.ts, which
 * has no DEMO_MODE concept anywhere in its job/scheduler/sweep logic).
 */
export function registerAlertingResolver(): void {
  configureAlerting(async () => {
    const [row] = await db.select().from(tables.settings).where(eq(tables.settings.key, "smtp"));
    const smtp = row?.value as Partial<SmtpSettingsStored> | undefined;
    if (!smtp?.enabled || !smtp.host) return null;

    const rows = await db
      .select({ email: tables.engineers.email })
      .from(tables.engineers)
      .where(and(eq(tables.engineers.receiveJobAlerts, true), eq(tables.engineers.status, "active")));
    const to = rows.map((r) => r.email).filter((e): e is string => !!e);
    if (to.length === 0) return null;

    const resolved: AlertConfig = {
      host: smtp.host,
      port: smtp.port ?? 587,
      user: smtp.user || undefined,
      pass: smtp.passEncrypted ? decrypt(smtp.passEncrypted) : undefined,
      secure: smtp.secure ?? false,
      from: smtp.from || smtp.user || "patchpilot@localhost",
      to,
    };
    return resolved;
  });
}
