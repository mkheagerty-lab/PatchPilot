import { describe, expect, it } from "vitest";
import {
  can,
  isRole,
  permissionsFor,
  PERMISSIONS,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  ROLES,
  USER_STATUS_LABELS,
  USER_STATUSES,
  type Permission,
  type Role,
} from "./rbac.js";

describe("the role matrix", () => {
  it("grants admin every permission — the role exists to have no gaps", () => {
    for (const permission of PERMISSIONS) {
      expect(can("admin", permission)).toBe(true);
    }
  });

  it("gives technician operations read and write", () => {
    expect(can("technician", "operations:read")).toBe(true);
    expect(can("technician", "operations:write")).toBe(true);
  });

  it("lets a technician read the catalog but not change it", () => {
    // Remediation can't be dispatched without resolving a title to a package,
    // so catalog *read* is an input to the technician's own job. Catalog write
    // changes what actually executes on a customer endpoint — that's an admin act.
    expect(can("technician", "catalog:read")).toBe(true);
    expect(can("technician", "catalog:write")).toBe(false);
  });

  it("keeps settings and user management away from technicians", () => {
    expect(can("technician", "settings:read")).toBe(true);
    expect(can("technician", "settings:write")).toBe(false);
    expect(can("technician", "users:read")).toBe(false);
    expect(can("technician", "users:manage")).toBe(false);
  });

  it("gives reader no write permission at all", () => {
    // The guarantee the whole role rests on: assert it over the permission list
    // rather than a hand-written set, so a future ":write" permission is caught
    // here the moment it's added.
    const writes = PERMISSIONS.filter((p) => p.endsWith(":write"));
    expect(writes.length).toBeGreaterThan(0);
    for (const permission of writes) {
      expect(can("reader", permission)).toBe(false);
    }
    expect(can("reader", "users:manage")).toBe(false);
  });

  it("lets a reader read operations, catalog, settings and the audit log", () => {
    expect(can("reader", "operations:read")).toBe(true);
    expect(can("reader", "catalog:read")).toBe(true);
    expect(can("reader", "settings:read")).toBe(true);
    // Withholding the record of what happened from the oversight role would be
    // backwards — see the note in rbac.ts.
    expect(can("reader", "audit:read")).toBe(true);
  });

  it("keeps user management admin-only", () => {
    for (const role of ROLES) {
      expect(can(role, "users:manage")).toBe(role === "admin");
      expect(can(role, "users:read")).toBe(role === "admin");
    }
  });

  it("resolves every (role, permission) pair to a boolean, never undefined", () => {
    for (const role of ROLES) {
      for (const permission of PERMISSIONS) {
        expect(typeof can(role, permission)).toBe("boolean");
      }
    }
  });

  it("narrows privilege monotonically: reader ⊆ technician ⊆ admin", () => {
    // The three built-ins are a strict hierarchy. If a future edit gives a
    // narrower role something a broader one lacks, that's almost certainly a
    // mistake, and this catches it without anyone having to notice.
    for (const permission of PERMISSIONS) {
      if (can("reader", permission)) expect(can("technician", permission)).toBe(true);
      if (can("technician", permission)) expect(can("admin", permission)).toBe(true);
    }
  });

  it("grants nothing outside the declared permission list", () => {
    const known = new Set<string>(PERMISSIONS);
    for (const role of ROLES) {
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(known.has(permission)).toBe(true);
      }
    }
  });

  it("declares no permission twice for a role", () => {
    for (const role of ROLES) {
      const granted = ROLE_PERMISSIONS[role];
      expect(new Set(granted).size).toBe(granted.length);
    }
  });
});

describe("permissionsFor", () => {
  it("returns the same grant `can` enforces", () => {
    for (const role of ROLES) {
      const granted = new Set<Permission>(permissionsFor(role));
      for (const permission of PERMISSIONS) {
        expect(granted.has(permission)).toBe(can(role, permission));
      }
    }
  });
});

describe("isRole", () => {
  it("accepts the three built-ins", () => {
    for (const role of ROLES) {
      expect(isRole(role)).toBe(true);
    }
  });

  it("rejects anything else, including the retired engineer_role values", () => {
    // Migration 0034 mapped these away; a stale client sending one must not
    // resolve to a role by accident.
    for (const value of ["engineer", "lead", "Admin", "", "administrator"]) {
      expect(isRole(value)).toBe(false);
    }
  });
});

describe("display metadata", () => {
  it("labels and describes every role", () => {
    for (const role of ROLES) {
      expect(ROLE_LABELS[role]).toBeTruthy();
      expect(ROLE_DESCRIPTIONS[role]).toBeTruthy();
    }
  });

  it("labels every account status", () => {
    for (const status of USER_STATUSES) {
      expect(USER_STATUS_LABELS[status]).toBeTruthy();
    }
  });

  it("orders roles most- to least-privileged, so the picker reads top-down", () => {
    const counts = ROLES.map((role: Role) => ROLE_PERMISSIONS[role].length);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });
});
