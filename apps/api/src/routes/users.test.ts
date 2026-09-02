import { describe, expect, it } from "vitest";
import { normalizeUpn, wouldOrphanAdmins } from "./users.js";

describe("normalizeUpn", () => {
  it("lower-cases and trims a well-formed UPN", () => {
    expect(normalizeUpn("  Jane.Doe@Contoso.COM  ")).toEqual({ ok: true, upn: "jane.doe@contoso.com" });
  });

  it("rejects a value with no @", () => {
    expect(normalizeUpn("jane.doe")).toEqual({
      ok: false,
      error: expect.stringContaining("user principal name"),
    });
  });

  it("rejects a leading or trailing @", () => {
    expect(normalizeUpn("@contoso.com").ok).toBe(false);
    expect(normalizeUpn("jane.doe@").ok).toBe(false);
  });

  it("rejects more than one @", () => {
    expect(normalizeUpn("jane@doe@contoso.com").ok).toBe(false);
  });

  it("rejects an empty or whitespace-only string", () => {
    expect(normalizeUpn("").ok).toBe(false);
    expect(normalizeUpn("   ").ok).toBe(false);
  });
});

describe("wouldOrphanAdmins", () => {
  it("never blocks a mutation on a row that isn't a load-bearing admin", () => {
    // Not an admin at all.
    expect(
      wouldOrphanAdmins({ targetRole: "technician", targetStatus: "active", nextRole: "reader", otherActiveAdmins: 0 }),
    ).toBe(false);
    // An admin, but already disabled — not load-bearing.
    expect(
      wouldOrphanAdmins({ targetRole: "admin", targetStatus: "disabled", deleting: true, otherActiveAdmins: 0 }),
    ).toBe(false);
  });

  it("blocks demoting the last active admin", () => {
    expect(
      wouldOrphanAdmins({ targetRole: "admin", targetStatus: "active", nextRole: "technician", otherActiveAdmins: 0 }),
    ).toBe(true);
  });

  it("allows demoting an admin when another active admin exists", () => {
    expect(
      wouldOrphanAdmins({ targetRole: "admin", targetStatus: "active", nextRole: "technician", otherActiveAdmins: 1 }),
    ).toBe(false);
  });

  it("blocks disabling the last active admin", () => {
    expect(
      wouldOrphanAdmins({ targetRole: "admin", targetStatus: "active", nextStatus: "disabled", otherActiveAdmins: 0 }),
    ).toBe(true);
  });

  it("blocks deleting the last active admin", () => {
    expect(
      wouldOrphanAdmins({ targetRole: "admin", targetStatus: "active", deleting: true, otherActiveAdmins: 0 }),
    ).toBe(true);
  });

  it("allows deleting an admin when another active admin exists", () => {
    expect(
      wouldOrphanAdmins({ targetRole: "admin", targetStatus: "active", deleting: true, otherActiveAdmins: 1 }),
    ).toBe(false);
  });

  it("allows a mutation that keeps the row an active admin (e.g. a rename)", () => {
    // role/status omitted entirely, as a displayName-only PATCH would leave them.
    expect(wouldOrphanAdmins({ targetRole: "admin", targetStatus: "active", otherActiveAdmins: 0 })).toBe(false);
  });

  it("allows re-enabling or re-promoting a row that was already the problem", () => {
    // Setting status back to active on an admin that was disabled doesn't
    // orphan anything — it's the opposite direction.
    expect(
      wouldOrphanAdmins({ targetRole: "admin", targetStatus: "disabled", nextStatus: "active", otherActiveAdmins: 0 }),
    ).toBe(false);
  });
});
