export type NodeCategory =
  | "actor"
  | "app"
  | "identity"
  | "tenant"
  | "external-ms"
  | "device";

/**
 * Glyph drawn inside the node box. Defaults to the category's natural shape
 * (see SHAPE_FOR_CATEGORY) — set explicitly only when one category needs two
 * different objects, e.g. Defender (shield) and Intune/Graph (cloud) are both
 * "external-ms" so they share a legend colour but not a glyph.
 */
export type ArchShape =
  | "person"
  | "server"
  | "cloud"
  | "shield"
  | "device"
  | "identity";

export interface ArchNode {
  id: string;
  label: string;
  category: NodeCategory;
  shape?: ArchShape;
  col: number;
  row: number;
  colSpan?: number;
  description: string;
  detail: {
    summary: string;
    facts?: { label: string; value: string }[];
    source?: string;
  };
}

export type EdgeStyle = "sync" | "async" | "data";

export interface ArchEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  style: EdgeStyle;
  /** Manual routing (grid coordinates) for backward/elbow edges that would otherwise cross nodes. */
  waypoints?: { col: number; row: number }[];
}

/** Tinted boundary box + label, e.g. a tenant or organizational boundary. */
export interface ArchGroup {
  id: string;
  label: string;
  colRange: [number, number];
  rowRange: [number, number];
  tone?: "customer" | "microsoft" | "msp";
}

export interface ArchDiagramData {
  columns: number;
  rows: number;
  nodes: ArchNode[];
  edges: ArchEdge[];
  groups?: ArchGroup[];
}
