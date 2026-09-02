import { NODE_TOKENS, edgeDashArray } from "./palette";
import type { EdgeStyle, NodeCategory } from "./types";

const EDGE_STYLE_LABEL: Record<EdgeStyle, string> = {
  sync: "Sync",
  async: "Async",
  data: "Data read/write",
};

export function ArchLegend({
  categories,
  styles,
}: {
  categories: NodeCategory[];
  styles: EdgeStyle[];
}) {
  return (
    <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 border-t border-slate-100 pt-4">
      {categories.map((category) => {
        const token = NODE_TOKENS[category];
        return (
          <div key={category} className="flex items-center gap-1.5 text-xs text-slate-500">
            <span className={`h-2 w-2 shrink-0 rounded-full ${token.dot}`} />
            {token.label}
          </div>
        );
      })}
      {styles.length > 1 && (
        <div className="ml-auto flex flex-wrap gap-x-5 gap-y-2 text-xs text-slate-400">
          {styles.map((style) => (
            <span key={style} className="flex items-center gap-1.5">
              <svg width="20" height="8" aria-hidden>
                <line
                  x1="0"
                  y1="4"
                  x2="20"
                  y2="4"
                  stroke="#94a3b8"
                  strokeWidth="1.5"
                  strokeDasharray={edgeDashArray(style)}
                />
              </svg>
              {EDGE_STYLE_LABEL[style]}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
