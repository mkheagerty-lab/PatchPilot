import { and, eq } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import { decrypt } from "@patchpilot/graph";
import { configureAlerting, type AlertConfig } from "@patchpilot/shared/alerting";
import { config } from "./config.js";
import { demoSettings } from "./routes/settings-store.js";
import { demoEngineers } from "./auth/demo-engineers.js";

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
 * Wires the DB-backed Settings -> Notifications config (see
 * routes/notification-settings.ts) into packages/shared's alerting module.
 * Lives here rather than in the shared package because packages/shared
 * cannot depend on @patchpilot/db (db already depends on shared) — see the
 * doc comment on packages/shared/src/alerting.ts.
 *
 * Called once at process startup (apps/index.ts). Every alert send re-reads
 * both the relay settings and the current opt-in list, so a toggle on either
 * takes effect on the very next send without a restart.
 */
export function registerAlertingResolver(): void {
  configureAlerting(async () => {
    let smtp: Partial<SmtpSettingsStored> | undefined;
    let recipients: (string | null)[];

    if (config.DEMO_MODE) {
      smtp = demoSettings.smtp as Partial<SmtpSettingsStored> | undefined;
      recipients = demoEngineers.filter((e) => e.receiveJobAlerts && e.status === "active").map((e) => e.email);
    } else {
      const [row] = await db.select().from(tables.settings).where(eq(tables.settings.key, "smtp"));
      smtp = row?.value as Partial<SmtpSettingsStored> | undefined;
      const rows = await db
        .select({ email: tables.engineers.email })
        .from(tables.engineers)
        .where(and(eq(tables.engineers.receiveJobAlerts, true), eq(tables.engineers.status, "active")));
      recipients = rows.map((r) => r.email);
    }

    if (!smtp?.enabled || !smtp.host) return null;

    const to = recipients.filter((e): e is string => !!e);
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
