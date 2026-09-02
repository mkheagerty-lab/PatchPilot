// Node-category colour tokens for the Architecture diagrams — same Token
// shape as ../../../lib/palette.ts, but deliberately a separate file: that
// module is scoped to status semantics (severity/SLA/compliance/job-status/
// coverage) and explicitly not meant to be extended for unrelated categories.
import type { ArchShape, EdgeStyle, NodeCategory } from "./types";

interface Token {
  label: string;
  chip: string;
  fill: string;
  stroke: string;
  dot: string;
}

export const NODE_TOKENS: Record<NodeCategory, Token> = {
  actor: {
    label: "Person",
    chip: "bg-rose-100 text-rose-700",
    fill: "#f43f5e",
    stroke: "#e11d48",
    dot: "bg-rose-500",
  },
  app: {
    label: "PatchPilot",
    chip: "bg-indigo-100 text-indigo-700",
    fill: "#6366f1",
    stroke: "#4f46e5",
    dot: "bg-indigo-500",
  },
  identity: {
    label: "Identity",
    chip: "bg-violet-100 text-violet-700",
    fill: "#8b5cf6",
    stroke: "#7c3aed",
    dot: "bg-violet-500",
  },
  tenant: {
    label: "Tenant",
    chip: "bg-sky-100 text-sky-700",
    fill: "#0ea5e9",
    stroke: "#0284c7",
    dot: "bg-sky-500",
  },
  "external-ms": {
    label: "Microsoft API",
    chip: "bg-amber-100 text-amber-700",
    fill: "#f59e0b",
    stroke: "#d97706",
    dot: "bg-amber-500",
  },
  device: {
    label: "Managed device",
    chip: "bg-emerald-100 text-emerald-700",
    fill: "#10b981",
    stroke: "#059669",
    dot: "bg-emerald-500",
  },
};

/** Glyph used when a node doesn't override it with `shape`. */
export const SHAPE_FOR_CATEGORY: Record<NodeCategory, ArchShape> = {
  actor: "person",
  app: "server",
  identity: "identity",
  tenant: "cloud",
  "external-ms": "cloud",
  device: "device",
};

/** Soft tints for group boundaries, so a tenant perimeter reads as a region. */
export const GROUP_TONES = {
  customer: { fill: "#f0f9ff", stroke: "#7dd3fc", text: "#0369a1" },
  microsoft: { fill: "#fffbeb", stroke: "#fcd34d", text: "#b45309" },
  msp: { fill: "#f5f3ff", stroke: "#c4b5fd", text: "#6d28d9" },
} as const;

const EDGE_STYLE_DASH: Record<EdgeStyle, string | undefined> = {
  sync: undefined,
  async: "6 4",
  data: "1.5 3.5",
};

export function edgeDashArray(style: EdgeStyle): string | undefined {
  return EDGE_STYLE_DASH[style];
}
