import type { ReactNode } from "react";
import type { IntuneAssignmentSummary } from "../lib/api";

/**
 * Renders the real assignment targets — a synced-in profile can have multiple
 * include groups, "All devices"/"All users", or none, not just a single
 * include+exclude pair. Shared across all four Windows Updates hub tabs
 * (Feature Updates, Quality Updates, Update Rings, Driver Updates), which all
 * key off the same `IntuneAssignmentSummary[]` shape.
 */
export function AssignmentSummary({ assignments }: { assignments: IntuneAssignmentSummary[] }): ReactNode {
  if (assignments.length === 0) return <span className="text-slate-400">—</span>;

  const includes = assignments.filter((a) => a.kind === "include");
  const excludes = assignments.filter((a) => a.kind === "exclude");
  const parts: string[] = [];
  if (assignments.some((a) => a.kind === "all-devices")) parts.push("All devices");
  if (assignments.some((a) => a.kind === "all-users")) parts.push("All users");
  parts.push(...includes.map((a) => a.groupName || a.groupId || "Unknown group"));

  return (
    <span>
      {parts.length > 0 ? parts.join(", ") : "—"}
      {excludes.length > 0 && (
        <span className="ml-1.5 inline-flex items-center rounded-full bg-red-50 px-1.5 py-0.5 text-[11px] font-medium text-red-600">
          excl. {excludes.map((a) => a.groupName || a.groupId || "unknown").join(", ")}
        </span>
      )}
    </span>
  );
}

/** Plain-text form for CSV export — no JSX. */
export function assignmentSummaryText(assignments: IntuneAssignmentSummary[]): string {
  if (assignments.length === 0) return "";
  const includes = assignments.filter((a) => a.kind === "include");
  const excludes = assignments.filter((a) => a.kind === "exclude");
  const parts: string[] = [];
  if (assignments.some((a) => a.kind === "all-devices")) parts.push("All devices");
  if (assignments.some((a) => a.kind === "all-users")) parts.push("All users");
  parts.push(...includes.map((a) => a.groupName || a.groupId || "Unknown group"));
  let text = parts.join(", ");
  if (excludes.length > 0) {
    text += ` (excl. ${excludes.map((a) => a.groupName || a.groupId || "unknown").join(", ")})`;
  }
  return text;
}
