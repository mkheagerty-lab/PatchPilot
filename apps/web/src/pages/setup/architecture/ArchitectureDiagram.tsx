import { useMemo, useState } from "react";
import { SlideOver, DetailRow } from "../../../components/ui";
import { ArchIcon } from "./ArchIcon";
import { ArchLegend } from "./ArchLegend";
import {
  GROUP_TONES,
  NODE_TOKENS,
  SHAPE_FOR_CATEGORY,
  edgeDashArray,
} from "./palette";
import type {
  ArchDiagramData,
  ArchEdge,
  ArchNode,
  EdgeStyle,
  NodeCategory,
} from "./types";

// cellW is deliberately much wider than nodeW: the gap between columns is the
// only place an edge label can sit, so it has to fit one.
const GRID = { cellW: 310, cellH: 150, nodeW: 200, nodeH: 76, pad: 32 };
/** Perpendicular spacing between edges that connect the same pair of nodes. */
const PARALLEL_GAP = 14;
/** Corner radius where an orthogonal route changes direction. */
const BEND_RADIUS = 8;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
}

interface Point {
  x: number;
  y: number;
}

function boxFor(node: ArchNode): Box {
  const span = node.colSpan ?? 1;
  const x = GRID.pad + node.col * GRID.cellW + (GRID.cellW - GRID.nodeW) / 2;
  const y = GRID.pad + node.row * GRID.cellH + (GRID.cellH - GRID.nodeH) / 2;
  const w = GRID.nodeW + (span - 1) * GRID.cellW;
  return { x, y, w, h: GRID.nodeH, cx: x + w / 2, cy: y + GRID.nodeH / 2 };
}

/**
 * Orthogonal route between two boxes: a straight run when they share a row or
 * column, otherwise a Z-elbow that leaves one box and enters the other square
 * to its edge — which is what makes these read as network diagrams rather than
 * a spray of diagonals. `offset` shifts the whole run perpendicular so two
 * edges between the same pair of nodes don't land on top of each other.
 */
function routePoints(from: Box, to: Box, offset: number): Point[] {
  const dx = to.cx - from.cx;
  const dy = to.cy - from.cy;
  const sameRow = Math.abs(dy) < 1;
  const sameCol = Math.abs(dx) < 1;

  if (sameRow) {
    const y = from.cy + offset;
    return dx >= 0
      ? [{ x: from.x + from.w, y }, { x: to.x, y }]
      : [{ x: from.x, y }, { x: to.x + to.w, y }];
  }

  if (sameCol) {
    const x = from.cx + offset;
    return dy >= 0
      ? [{ x, y: from.y + from.h }, { x, y: to.y }]
      : [{ x, y: from.y }, { x, y: to.y + to.h }];
  }

  // Different column: always exit left/right and jog across a vertical lane,
  // never the other way round. These diagrams read left-to-right, so a
  // vertical-first elbow would dive through whatever node sits between the two
  // rows. Because the lane sits midway between the columns, every edge leaving
  // one node shares it — which is exactly the trunk-and-branch look a fan-out
  // should have.
  const startX = dx >= 0 ? from.x + from.w : from.x;
  const endX = dx >= 0 ? to.x : to.x + to.w;
  const midX = (startX + endX) / 2 + offset;
  return [
    { x: startX, y: from.cy },
    { x: midX, y: from.cy },
    { x: midX, y: to.cy },
    { x: endX, y: to.cy },
  ];
}

/** Turns a point list into a path, rounding each bend. */
function pathFrom(points: Point[]): string {
  if (points.length < 2) return "";
  const first = points[0]!;
  let d = `M ${first.x} ${first.y}`;

  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]!;
    const corner = points[i]!;
    const next = points[i + 1]!;

    const inLen = Math.hypot(corner.x - prev.x, corner.y - prev.y);
    const outLen = Math.hypot(next.x - corner.x, next.y - corner.y);
    const r = Math.min(BEND_RADIUS, inLen / 2, outLen / 2);
    if (r < 0.5) {
      d += ` L ${corner.x} ${corner.y}`;
      continue;
    }

    const enter = {
      x: corner.x - ((corner.x - prev.x) / inLen) * r,
      y: corner.y - ((corner.y - prev.y) / inLen) * r,
    };
    const exit = {
      x: corner.x + ((next.x - corner.x) / outLen) * r,
      y: corner.y + ((next.y - corner.y) / outLen) * r,
    };
    d += ` L ${enter.x} ${enter.y} Q ${corner.x} ${corner.y} ${exit.x} ${exit.y}`;
  }

  const last = points[points.length - 1]!;
  return `${d} L ${last.x} ${last.y}`;
}

/** Midpoint of the longest segment — where a label sits without crossing a bend. */
function labelAnchor(points: Point[]): Point {
  let best = { a: points[0]!, b: points[1]!, len: -1 };
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > best.len) best = { a, b, len };
  }
  return { x: (best.a.x + best.b.x) / 2, y: (best.a.y + best.b.y) / 2 };
}

/** SVG <text> doesn't wrap — pack words into at most `maxLines` lines. */
function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = word;
    if (lines.length === maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines) {
    const consumed = lines.join(" ");
    if (consumed.length < text.length) {
      const last = lines[maxLines - 1]!;
      lines[maxLines - 1] = `${last.slice(0, Math.max(0, maxChars - 1))}…`;
    }
  }
  return lines;
}

/** Group edges by unordered node pair so parallel runs can be fanned apart. */
function offsetsFor(edges: ArchEdge[]): Map<string, number> {
  const byPair = new Map<string, ArchEdge[]>();
  for (const edge of edges) {
    const key = [edge.from, edge.to].sort().join("::");
    const list = byPair.get(key);
    if (list) list.push(edge);
    else byPair.set(key, [edge]);
  }

  const offsets = new Map<string, number>();
  for (const list of byPair.values()) {
    list.forEach((edge, i) => {
      offsets.set(edge.id, (i - (list.length - 1) / 2) * PARALLEL_GAP);
    });
  }
  return offsets;
}

export function ArchitectureDiagram({
  data,
  ariaLabel,
}: {
  data: ArchDiagramData;
  ariaLabel: string;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const boxes = useMemo(() => {
    const map = new Map<string, Box>();
    for (const node of data.nodes) map.set(node.id, boxFor(node));
    return map;
  }, [data.nodes]);

  /** Routes are computed once and drawn twice — lines below the nodes, labels above. */
  const routedEdges = useMemo(() => {
    const offsets = offsetsFor(data.edges);
    return data.edges.flatMap((edge) => {
      const fromBox = boxes.get(edge.from);
      const toBox = boxes.get(edge.to);
      if (!fromBox || !toBox) return [];

      const base = routePoints(fromBox, toBox, offsets.get(edge.id) ?? 0);
      const points = edge.waypoints?.length
        ? [
            base[0]!,
            ...edge.waypoints.map((w) => ({
              x: GRID.pad + w.col * GRID.cellW + GRID.cellW / 2,
              y: GRID.pad + w.row * GRID.cellH + GRID.cellH / 2,
            })),
            base[base.length - 1]!,
          ]
        : base;

      // A pair of edges is fanned apart by `offset`; sending each label to the
      // side its own line moved to doubles the gap between them, which two
      // labels 14px apart at diagram scale badly need.
      const offset = offsets.get(edge.id) ?? 0;
      return [{ edge, points, anchor: labelAnchor(points), labelBelow: offset > 0 }];
    });
  }, [data.edges, boxes]);

  const categories = useMemo(() => {
    const seen = new Set<NodeCategory>();
    for (const node of data.nodes) seen.add(node.category);
    return Array.from(seen);
  }, [data.nodes]);

  const styles = useMemo(() => {
    const seen = new Set<EdgeStyle>();
    for (const edge of data.edges) seen.add(edge.style);
    return Array.from(seen);
  }, [data.edges]);

  const connectedIds = useMemo(() => {
    if (!hoveredId) return null;
    const ids = new Set<string>([hoveredId]);
    for (const edge of data.edges) {
      if (edge.from === hoveredId) ids.add(edge.to);
      if (edge.to === hoveredId) ids.add(edge.from);
    }
    return ids;
  }, [hoveredId, data.edges]);

  const selectedNode = data.nodes.find((n) => n.id === selectedId) ?? null;

  const width = GRID.pad * 2 + data.columns * GRID.cellW;
  const height = GRID.pad * 2 + data.rows * GRID.cellH;

  return (
    <div>
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width="100%"
          style={{ minWidth: Math.min(width, 640) }}
          role="img"
          aria-label={ariaLabel}
        >
          <defs>
            {[
              { id: "arch-arrow", color: "#94a3b8" },
              { id: "arch-arrow-active", color: "#334155" },
            ].map((marker) => (
              <marker
                key={marker.id}
                id={marker.id}
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M0 0 L10 5 L0 10 Z" fill={marker.color} />
              </marker>
            ))}
          </defs>

          {data.groups?.map((group) => {
            const tone = GROUP_TONES[group.tone ?? "customer"];
            const x = GRID.pad + group.colRange[0] * GRID.cellW + 10;
            const y = GRID.pad + group.rowRange[0] * GRID.cellH + 6;
            const w = (group.colRange[1] - group.colRange[0] + 1) * GRID.cellW - 20;
            const h = (group.rowRange[1] - group.rowRange[0] + 1) * GRID.cellH - 12;
            return (
              <g key={group.id}>
                <rect
                  x={x}
                  y={y}
                  width={w}
                  height={h}
                  rx={14}
                  fill={tone.fill}
                  stroke={tone.stroke}
                  strokeWidth={1.5}
                  strokeDasharray="5 4"
                />
                <text
                  x={x + 14}
                  y={y + 18}
                  fill={tone.text}
                  className="text-[10px] font-semibold uppercase tracking-wide"
                >
                  {group.label}
                </text>
              </g>
            );
          })}

          {routedEdges.map(({ edge, points }) => {
            const active = !!hoveredId && (edge.from === hoveredId || edge.to === hoveredId);
            return (
              <path
                key={edge.id}
                d={pathFrom(points)}
                fill="none"
                stroke={active ? "#334155" : "#94a3b8"}
                strokeWidth={active ? 2 : 1.5}
                strokeDasharray={edgeDashArray(edge.style)}
                markerEnd={`url(#${active ? "arch-arrow-active" : "arch-arrow"})`}
                className="transition-opacity duration-150"
                style={{ opacity: hoveredId && !active ? 0.15 : 1 }}
              />
            );
          })}

          {data.nodes.map((node) => {
            const box = boxes.get(node.id)!;
            const token = NODE_TOKENS[node.category];
            const shape = node.shape ?? SHAPE_FOR_CATEGORY[node.category];
            const dimmed = connectedIds ? !connectedIds.has(node.id) : false;
            const isHovered = hoveredId === node.id;
            const descLines = wrapText(node.description, 30, 2);

            return (
              <g
                key={node.id}
                role="button"
                tabIndex={0}
                aria-label={`${node.label}: ${node.description}`}
                className="cursor-pointer transition-opacity duration-150 outline-none"
                style={{ opacity: dimmed ? 0.35 : 1 }}
                onMouseEnter={() => setHoveredId(node.id)}
                onMouseLeave={() => setHoveredId(null)}
                onFocus={() => setHoveredId(node.id)}
                onBlur={() => setHoveredId(null)}
                onClick={() => setSelectedId(node.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedId(node.id);
                  }
                }}
              >
                <rect
                  x={box.x}
                  y={box.y}
                  width={box.w}
                  height={box.h}
                  rx={10}
                  fill="#ffffff"
                  stroke={isHovered ? token.stroke : "#cbd5e1"}
                  strokeWidth={isHovered ? 2.5 : 1.5}
                />
                {/* Category colour reads as a left spine rather than a lone dot. */}
                <rect x={box.x} y={box.y} width={4} height={box.h} fill={token.fill} rx={2} />
                <ArchIcon shape={shape} x={box.x + 14} y={box.y + 11} color={token.stroke} />
                <text
                  x={box.x + 42}
                  y={box.y + 26}
                  className="fill-slate-800 text-[12.5px] font-semibold"
                >
                  {node.label}
                </text>
                <text x={box.x + 14} y={box.y + 50} className="fill-slate-500 text-[10px]">
                  {descLines.map((line, i) => (
                    <tspan key={line} x={box.x + 14} dy={i === 0 ? 0 : 12}>
                      {line}
                    </tspan>
                  ))}
                </text>
              </g>
            );
          })}

          {/* Labels last: a node box painted over a label would clip it. */}
          {routedEdges.map(({ edge, anchor, labelBelow }) => {
            if (!edge.label) return null;
            const active = !!hoveredId && (edge.from === hoveredId || edge.to === hoveredId);
            return (
              // Painted stroke-first so the label reads as a gap in the line
              // rather than sitting on top of it.
              <text
                key={edge.id}
                x={anchor.x}
                y={anchor.y + (labelBelow ? 14 : -7)}
                textAnchor="middle"
                paintOrder="stroke"
                stroke="#ffffff"
                strokeWidth={4}
                strokeLinejoin="round"
                className={`pointer-events-none text-[10px] transition-opacity duration-150 ${
                  active ? "fill-slate-700" : "fill-slate-500"
                }`}
                style={{ opacity: hoveredId && !active ? 0.15 : 1 }}
              >
                {edge.label}
              </text>
            );
          })}
        </svg>
      </div>

      <ArchLegend categories={categories} styles={styles} />

      <SlideOver
        open={!!selectedNode}
        onClose={() => setSelectedId(null)}
        title={selectedNode?.label ?? ""}
        subtitle={selectedNode?.description}
      >
        {selectedNode && (
          <>
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                NODE_TOKENS[selectedNode.category].chip
              }`}
            >
              {NODE_TOKENS[selectedNode.category].label}
            </span>
            <p className="mt-4 text-sm text-slate-700">{selectedNode.detail.summary}</p>
            {selectedNode.detail.facts && selectedNode.detail.facts.length > 0 && (
              <dl className="mt-4">
                {selectedNode.detail.facts.map((fact) => (
                  <DetailRow key={fact.label} label={fact.label}>
                    {fact.value}
                  </DetailRow>
                ))}
              </dl>
            )}
            {selectedNode.detail.source && (
              <p className="mt-4 break-all font-mono text-xs text-slate-400">
                {selectedNode.detail.source}
              </p>
            )}
          </>
        )}
      </SlideOver>
    </div>
  );
}
