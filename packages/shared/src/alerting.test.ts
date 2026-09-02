import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMail = vi.fn();
vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => ({ sendMail })),
  },
}));

const ORIGINAL_ENV = { ...process.env };

/** Fresh module import per test: the transport cache and cooldown map are
 * module-level state that must not leak between cases. */
async function freshModule() {
  vi.resetModules();
  return import("./alerting.js");
}

describe("alerting", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.SMTP_HOST;
    delete process.env.ALERT_EMAIL_TO;
    sendMail.mockReset();
    sendMail.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("is unconfigured when SMTP_HOST/ALERT_EMAIL_TO are unset", async () => {
    const { isAlertingConfigured } = await freshModule();
    expect(await isAlertingConfigured()).toBe(false);
  });

  it("never sends when unconfigured", async () => {
    const { sendAlertEmail } = await freshModule();
    await sendAlertEmail("worker", { key: "x", subject: "s", body: "b" });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("sends to every comma-separated recipient once configured", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.ALERT_EMAIL_TO = "a@example.com, b@example.com";
    const { sendAlertEmail, isAlertingConfigured } = await freshModule();

    expect(await isAlertingConfigured()).toBe(true);
    await sendAlertEmail("api", { key: "k1", subject: "Boom", body: "detail" });

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ["a@example.com", "b@example.com"],
        subject: "[PatchPilot/api] Boom",
        text: "detail",
      }),
    );
  });

  it("drops a repeat of the same key within the cooldown window", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.ALERT_EMAIL_TO = "a@example.com";
    const { sendAlertEmail } = await freshModule();

    await sendAlertEmail("api", { key: "dup", subject: "s", body: "b" });
    await sendAlertEmail("api", { key: "dup", subject: "s", body: "b" });

    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("does not dedup across distinct keys", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.ALERT_EMAIL_TO = "a@example.com";
    const { sendAlertEmail } = await freshModule();

    await sendAlertEmail("api", { key: "one", subject: "s", body: "b" });
    await sendAlertEmail("api", { key: "two", subject: "s", body: "b" });

    expect(sendMail).toHaveBeenCalledTimes(2);
  });

  it("prefers the injected resolver over env vars once configured", async () => {
    process.env.SMTP_HOST = "env-should-be-ignored.example.com";
    process.env.ALERT_EMAIL_TO = "env@example.com";
    const { sendAlertEmail, configureAlerting } = await freshModule();

    configureAlerting(async () => ({
      host: "db.example.com",
      port: 587,
      secure: false,
      from: "patchpilot@example.com",
      to: ["admin@example.com"],
    }));

    await sendAlertEmail("api", { key: "resolver", subject: "s", body: "b" });

    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: ["admin@example.com"] }));
  });

  it("stays a silent no-op when the resolver returns null", async () => {
    const { sendAlertEmail, configureAlerting, isAlertingConfigured } = await freshModule();
    configureAlerting(async () => null);

    expect(await isAlertingConfigured()).toBe(false);
    await sendAlertEmail("worker", { key: "x", subject: "s", body: "b" });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("never rejects even when the SMTP transport does", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.ALERT_EMAIL_TO = "a@example.com";
    sendMail.mockRejectedValueOnce(new Error("connection refused"));
    const { sendAlertEmail } = await freshModule();

    await expect(
      sendAlertEmail("api", { key: "err", subject: "s", body: "b" }),
    ).resolves.toBeUndefined();
  });
});
