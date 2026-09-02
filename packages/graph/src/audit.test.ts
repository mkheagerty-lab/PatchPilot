import { describe, expect, it } from "vitest";
import {
  decodeAuditCursor,
  encodeAuditCursor,
  inferCategory,
  matchesAuditQuery,
  type AuditRecord,
} from "./audit.js";

const record = (over: Partial<AuditRecord> = {}): AuditRecord => ({
  id: "11111111-1111-4111-8111-111111111111",
  engineer: "engineer@blackiron.example",
  actorType: "user",
  tenantId: "contoso-tenant-id",
  category: "action",
  action: "remediation:dispatch",
  endpoint: "/api/remediations",
  method: "POST",
  resourceType: "vulnerability",
  resourceId: "CVE-2026-1234",
  resourceLabel: "Google Chrome",
  summary: "Dispatched a winget upgrade for Google Chrome on WS-014",
  outcome: "success",
  detail: null,
  payloadHash: null,
  responseStatus: 200,
  latencyMs: 42,
  at: "2026-08-02T04:00:00.000Z",
  ...over,
});

describe("audit cursor", () => {
  it("round-trips a timestamp and id", () => {
    const source = record();
    const decoded = decodeAuditCursor(encodeAuditCursor(source));
    expect(decoded).toEqual({ at: source.at, id: source.id });
  });

  it("keeps the id distinct for rows sharing a timestamp", () => {
    // The whole reason the cursor is (at, id) and not just `at`: audit rows
    // routinely land in the same millisecond, and a bare `at <` would drop
    // every tied row at a page boundary.
    const at = "2026-08-02T04:00:00.000Z";
    const first = encodeAuditCursor({ at, id: "aaaaaaaa-1111-4111-8111-111111111111" });
    const second = encodeAuditCursor({ at, id: "bbbbbbbb-2222-4222-8222-222222222222" });
    expect(first).not.toBe(second);
    expect(decodeAuditCursor(first)?.id).toBe("aaaaaaaa-1111-4111-8111-111111111111");
    expect(decodeAuditCursor(second)?.id).toBe("bbbbbbbb-2222-4222-8222-222222222222");
  });

  it("is opaque — no unescaped separator leaks into the token", () => {
    expect(encodeAuditCursor(record())).not.toContain("|");
  });

  it("rejects garbage rather than paging from a nonsense position", () => {
    expect(decodeAuditCursor("")).toBeNull();
    expect(decodeAuditCursor("not-base64url!!")).toBeNull();
    // Valid base64url, but the decoded halves aren't a timestamp and an id.
    expect(decodeAuditCursor(Buffer.from("no-separator").toString("base64url"))).toBeNull();
    expect(decodeAuditCursor(Buffer.from("not-a-date|id").toString("base64url"))).toBeNull();
    expect(decodeAuditCursor(Buffer.from("2026-08-02T04:00:00.000Z|").toString("base64url")))
      .toBeNull();
  });
});

describe("inferCategory", () => {
  const entry = (endpoint: string) => ({ engineer: "e@x.example", endpoint, method: "GET" });

  it("files every GraphHost prefix as raw API traffic", () => {
    // `beta` shipped missing from this list, so ~700 raw beta reads surfaced in
    // the Actions view. client.ts now asserts the list covers GraphHost, and
    // this pins the behaviour that assertion exists to protect.
    expect(inferCategory(entry("graph:/deviceManagement/managedDevices"))).toBe("api_call");
    expect(inferCategory(entry("beta:/deviceManagement/managedDevices?$select=id"))).toBe(
      "api_call",
    );
    expect(inferCategory(entry("defender:/api/machines"))).toBe("api_call");
  });

  it("files hand-written pseudo-endpoints as domain actions", () => {
    expect(inferCategory(entry("catalog:override"))).toBe("action");
    expect(inferCategory(entry("manual-remediation:record"))).toBe("action");
    expect(inferCategory(entry("worker:job-timeout"))).toBe("action");
  });

  it("files a CHANNEL_SPECS endpoint template as an action, not API traffic", () => {
    // These are remediation dispatches; jobs.ts passes the template as `endpoint`.
    expect(inferCategory(entry("POST /api/machines/{machineId}/runliveresponse"))).toBe("action");
    expect(inferCategory(entry("POST /deviceManagement/managedDevices/{id}/syncDevice"))).toBe(
      "action",
    );
  });

  it("lets an explicit category and a named action override the endpoint shape", () => {
    expect(inferCategory({ ...entry("graph:/organization"), category: "action" })).toBe("action");
    expect(
      inferCategory({ ...entry("graph:/organization"), action: "tenant:sync" as const }),
    ).toBe("action");
  });
});

describe("matchesAuditQuery", () => {
  it("matches everything when the query is empty", () => {
    expect(matchesAuditQuery(record(), {})).toBe(true);
  });

  it("filters by category, treating \"all\" as no filter", () => {
    expect(matchesAuditQuery(record({ category: "api_call" }), { category: "action" })).toBe(false);
    expect(matchesAuditQuery(record({ category: "api_call" }), { category: "all" })).toBe(true);
  });

  it("does not leak global rows into a tenant-scoped view", () => {
    // A catalog refresh or a sign-in is not a Contoso event. Globals belong to
    // the All Tenants view only.
    expect(matchesAuditQuery(record({ tenantId: null }), { tenantId: "contoso-tenant-id" })).toBe(
      false,
    );
    expect(matchesAuditQuery(record(), { tenantId: "contoso-tenant-id" })).toBe(true);
    expect(matchesAuditQuery(record({ tenantId: null }), {})).toBe(true);
  });

  it("matches the actor exactly, including system sentinels", () => {
    expect(matchesAuditQuery(record({ engineer: "system:worker" }), { actor: "system:worker" }))
      .toBe(true);
    expect(matchesAuditQuery(record(), { actor: "someone.else@blackiron.example" })).toBe(false);
  });

  it("treats the action filter as a set, and excludes rows with no action", () => {
    expect(matchesAuditQuery(record(), { actions: ["remediation:dispatch", "job:delete"] })).toBe(
      true,
    );
    expect(matchesAuditQuery(record({ action: null }), { actions: ["remediation:dispatch"] })).toBe(
      false,
    );
  });

  it("applies the date window half-open, so [from, to) can't double-count a row", () => {
    const at = "2026-08-02T04:00:00.000Z";
    expect(matchesAuditQuery(record({ at }), { from: at })).toBe(true);
    expect(matchesAuditQuery(record({ at }), { to: at })).toBe(false);
    expect(matchesAuditQuery(record({ at }), { from: "2026-08-02T05:00:00.000Z" })).toBe(false);
  });

  it("searches summary, label, action, endpoint and actor, case-insensitively", () => {
    expect(matchesAuditQuery(record(), { q: "GOOGLE chrome" })).toBe(true);
    expect(matchesAuditQuery(record(), { q: "ws-014" })).toBe(true);
    expect(matchesAuditQuery(record(), { q: "blackiron" })).toBe(true);
    expect(matchesAuditQuery(record(), { q: "firefox" })).toBe(false);
  });
});
