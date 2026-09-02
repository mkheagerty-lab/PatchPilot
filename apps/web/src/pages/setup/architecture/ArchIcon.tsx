import type { ArchShape } from "./types";

/**
 * Network-topology glyphs. Each is drawn in a 20x20 local space and translated
 * into place, so callers only position the top-left corner. Stroke-based so a
 * single `color` drives the whole glyph.
 */
export function ArchIcon({
  shape,
  x,
  y,
  color,
}: {
  shape: ArchShape;
  x: number;
  y: number;
  color: string;
}) {
  const common = {
    fill: "none",
    stroke: color,
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  return (
    <g transform={`translate(${x}, ${y})`} aria-hidden>
      {shape === "person" && (
        <>
          <circle cx={10} cy={6} r={3.5} {...common} />
          <path d="M3.5 17.5c0-3.6 2.9-6.5 6.5-6.5s6.5 2.9 6.5 6.5" {...common} />
        </>
      )}

      {shape === "server" && (
        <>
          <rect x={3} y={3} width={14} height={5.5} rx={1.5} {...common} />
          <rect x={3} y={11.5} width={14} height={5.5} rx={1.5} {...common} />
          <line x1={6} y1={5.75} x2={6.01} y2={5.75} {...common} strokeWidth={2} />
          <line x1={6} y1={14.25} x2={6.01} y2={14.25} {...common} strokeWidth={2} />
        </>
      )}

      {shape === "cloud" && (
        <path
          d="M6 15.5h8.5a3.5 3.5 0 0 0 .4-7A5.5 5.5 0 0 0 4.6 9.7 3 3 0 0 0 6 15.5z"
          {...common}
        />
      )}

      {shape === "shield" && (
        <>
          <path d="M10 2.5 3.5 5.2v5c0 4 2.8 6.9 6.5 8.3 3.7-1.4 6.5-4.3 6.5-8.3v-5L10 2.5z" {...common} />
          <path d="M7.2 10.2l2 2 3.6-3.6" {...common} />
        </>
      )}

      {shape === "device" && (
        <>
          <rect x={3.5} y={4} width={13} height={9} rx={1.5} {...common} />
          <path d="M1.5 16.5h17" {...common} />
        </>
      )}

      {shape === "identity" && (
        <>
          <circle cx={7} cy={7} r={3.5} {...common} />
          <path d="M9.5 9.5 17 17M14.5 14.5l-2 2M17 17l-1.5 1.5" {...common} />
        </>
      )}
    </g>
  );
}
