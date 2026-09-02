import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTIONS,
  AUDIT_ACTION_GROUPS,
  AUDIT_ACTION_LABELS,
  csvCell,
  csvRow,
  deriveAuditOutcome,
  isAuditAction,
  isSystemActor,
  SYSTEM_ACTORS,
  systemActorLabel,
  type AuditAction,
} from "./audit.js";

describe("csvCell", () => {
  it("passes plain text through untouched", () => {
    expect(csvCell("Google Chrome")).toBe("Google Chrome");
    expect(csvCell(200)).toBe("200");
  });

  it("renders null and undefined as an empty cell, not the literal word", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("quotes commas, so a summary can't spill into the next column", () => {
    expect(csvCell("Synced Contoso — 12 devices, 40 CVEs")).toBe(
      '"Synced Contoso — 12 devices, 40 CVEs"',
    );
  });

  it("doubles embedded quotes per RFC 4180", () => {
    expect(csvCell('Microsoft returned "invalid_grant"')).toBe(
      '"Microsoft returned ""invalid_grant"""',
    );
  });

  it("quotes newlines, which multi-line failure details carry", () => {
    expect(csvCell("line one\nline two")).toBe('"line one\nline two"');
    expect(csvCell("line one\r\nline two")).toBe('"line one\r\nline two"');
  });

  it("neutralises leading formula characters Excel would evaluate", () => {
    for (const text of ["=1+1", "+SUM(A1)", "-2", "@import", "\ttab", "\rcr"]) {
      expect(csvCell(text).replace(/^"/, "").startsWith("'")).toBe(true);
    }
  });

  it("neutralises a formula AND quotes it when it also contains a comma", () => {
    // A device name Defender reported; both guards have to apply, in this order.
    expect(csvCell("=cmd|'/c calc'!A1,x")).toBe(`"'=cmd|'/c calc'!A1,x"`);
  });

  it("leaves a hyphen inside a value alone — only a leading one is a formula", () => {
    expect(csvCell("well-known-host")).toBe("well-known-host");
  });

  it("leaves a negative NUMBER alone, so the column stays numeric in Excel", () => {
    // `sla-compliance.csv`'s "Days remaining" is negative on every breached
    // row. Apostrophe-prefixing it would import the column as text.
    expect(csvCell(-88)).toBe("-88");
    expect(csvCell(-0.5)).toBe("-0.5");
    // The same characters arriving as a string are still a payload.
    expect(csvCell("-88")).toBe("'-88");
  });
});

describe("csvRow", () => {
  it("joins cells with commas and terminates with CRLF", () => {
    expect(csvRow(["a", "b", 1])).toBe("a,b,1\r\n");
  });

  it("preserves empty trailing columns so the header alignment holds", () => {
    expect(csvRow(["a", null, undefined])).toBe("a,,\r\n");
  });
});

describe("deriveAuditOutcome", () => {
  it("prefers the stored outcome over anything the status implies", () => {
    // A partial batch can still answer 200; the stored value is the truth.
    expect(deriveAuditOutcome("partial", 200)).toBe("partial");
    expect(deriveAuditOutcome("skipped", 200)).toBe("skipped");
  });

  it("derives from the status for rows that never stored one", () => {
    expect(deriveAuditOutcome(null, 200)).toBe("success");
    expect(deriveAuditOutcome(null, 399)).toBe("success");
    expect(deriveAuditOutcome(null, 400)).toBe("failure");
    expect(deriveAuditOutcome(null, 500)).toBe("failure");
  });

  it("reports null rather than guessing when there is no signal at all", () => {
    expect(deriveAuditOutcome(null, null)).toBeNull();
  });
});

describe("system actors", () => {
  it("recognises every reserved sentinel and no real UPN", () => {
    for (const actor of Object.values(SYSTEM_ACTORS)) {
      expect(isSystemActor(actor)).toBe(true);
    }
    expect(isSystemActor("engineer@blackiron.example")).toBe(false);
    // A UPN can't contain a colon, which is what makes the prefix collision-proof.
    expect(isSystemActor("anonymous")).toBe(false);
  });

  it("renders a sentinel as a readable component name", () => {
    expect(systemActorLabel(SYSTEM_ACTORS.autoSync)).toBe("Auto sync");
    expect(systemActorLabel(SYSTEM_ACTORS.chocolateyRefresh)).toBe("Chocolatey refresh");
  });

  it("returns a real UPN unchanged", () => {
    expect(systemActorLabel("engineer@blackiron.example")).toBe("engineer@blackiron.example");
  });
});

describe("the action taxonomy", () => {
  it("narrows known actions and rejects anything else", () => {
    expect(isAuditAction("remediation:dispatch")).toBe(true);
    expect(isAuditAction("remediation:teleport")).toBe(false);
    expect(isAuditAction("")).toBe(false);
  });

  it("gives every action a label — the Action column falls back to a raw slug otherwise", () => {
    for (const action of AUDIT_ACTIONS) {
      expect(AUDIT_ACTION_LABELS[action]).toBeTruthy();
    }
  });

  it("puts every action in exactly one dropdown group, so none is unfilterable", () => {
    const grouped: AuditAction[] = AUDIT_ACTION_GROUPS.flatMap((g) => [...g.actions]);
    expect([...grouped].sort()).toEqual([...AUDIT_ACTIONS].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });
});
