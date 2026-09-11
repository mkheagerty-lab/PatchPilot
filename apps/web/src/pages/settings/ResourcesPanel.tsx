import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type ServerHealthResources } from "../../lib/api";
import { Card, KpiCard } from "../../components/ui";
import { TrendAreaChart } from "../../components/charts/TrendAreaChart";

/** Keeps ~2.5 minutes of history at the 2.5s poll interval below — enough to
 *  see a spike coming and going without the chart getting unreadably dense. */
const MAX_SAMPLES = 60;
const POLL_INTERVAL_MS = 2_500;

interface Sample {
  time: string;
  cpuPercent: number | null;
  memoryPercent: number;
  diskPercent: number | null;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 GB";
  const gb = bytes / 1024 ** 3;
  return `${gb.toFixed(1)} GB`;
}

function formatPercent(percent: number | null): string {
  return percent === null ? "—" : `${percent.toFixed(0)}%`;
}

/**
 * Task-Manager-style live CPU/Memory/Disk graphs, built from a client-side
 * rolling sample buffer — there's no WebSocket/SSE infra in this app, so this
 * is TanStack Query's `refetchInterval` the same way Jobs.tsx polls, not a
 * push stream. `TrendAreaChart` is already generic enough for this; no new
 * chart component was needed.
 */
export function ResourcesPanel() {
  const [samples, setSamples] = useState<Sample[]>([]);
  // Guards against a query retry/refetch race appending the same sampledAt
  // twice — the buffer is keyed by wall-clock label, not a query cache key.
  const lastSampledAt = useRef<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["server-health", "resources"],
    queryFn: () => api.get<ServerHealthResources>("/api/server-health/resources"),
    refetchInterval: POLL_INTERVAL_MS,
  });

  useEffect(() => {
    if (!data || data.sampledAt === lastSampledAt.current) return;
    lastSampledAt.current = data.sampledAt;
    setSamples((prev) => {
      const next: Sample = {
        time: new Date(data.sampledAt).toLocaleTimeString([], { minute: "2-digit", second: "2-digit" }),
        cpuPercent: data.cpu.percent,
        memoryPercent: data.memory.percent,
        diskPercent: data.disk?.percent ?? null,
      };
      const combined = [...prev, next];
      return combined.length > MAX_SAMPLES ? combined.slice(combined.length - MAX_SAMPLES) : combined;
    });
  }, [data]);

  if (isLoading && !data) {
    return (
      <Card>
        <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card>
        <p className="text-sm text-rose-600 dark:text-rose-400">Could not load resource usage.</p>
      </Card>
    );
  }

  return (
    <div>
      {data.demoMode && (
        <div className="mb-4 rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          Demo mode: these are placeholder readings, not a live host sample.
        </div>
      )}

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard
          label="CPU"
          value={formatPercent(data.cpu.percent)}
          hint={`${data.cpu.cores} core${data.cpu.cores === 1 ? "" : "s"}`}
          tone={data.cpu.percent !== null && data.cpu.percent > 90 ? "critical" : "default"}
        />
        <KpiCard
          label="Memory"
          value={formatPercent(data.memory.percent)}
          hint={`${formatBytes(data.memory.usedBytes)} / ${formatBytes(data.memory.totalBytes)}`}
          tone={data.memory.percent > 90 ? "critical" : "default"}
        />
        <KpiCard
          label="Disk"
          value={data.disk ? formatPercent(data.disk.percent) : "—"}
          hint={data.disk ? `${formatBytes(data.disk.usedBytes)} / ${formatBytes(data.disk.totalBytes)}` : "Unavailable"}
          tone={data.disk && data.disk.percent > 90 ? "critical" : "default"}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <div className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-200">CPU %</div>
          <div className="h-48">
            <TrendAreaChart
              data={samples as unknown as Record<string, unknown>[]}
              xKey="time"
              series={[{ key: "cpuPercent", label: "CPU %", color: "#6366f1" }]}
            />
          </div>
        </Card>
        <Card>
          <div className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-200">Memory %</div>
          <div className="h-48">
            <TrendAreaChart
              data={samples as unknown as Record<string, unknown>[]}
              xKey="time"
              series={[{ key: "memoryPercent", label: "Memory %", color: "#0ea5e9" }]}
            />
          </div>
        </Card>
        <Card>
          <div className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-200">Disk %</div>
          <div className="h-48">
            <TrendAreaChart
              data={samples as unknown as Record<string, unknown>[]}
              xKey="time"
              series={[{ key: "diskPercent", label: "Disk %", color: "#f59e0b" }]}
            />
          </div>
        </Card>
      </div>

      <p className="mt-4 text-xs text-slate-400 dark:text-slate-500">
        Reflects the host machine — see infra/Dockerfile.api's doc comment on how procfs is shared
        with the container.
      </p>
    </div>
  );
}
