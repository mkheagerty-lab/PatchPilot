import { useState } from "react";
import { Link } from "react-router-dom";
import { ChartCard } from "../../components/charts/ChartCard";
import { HorizontalBarChart, type HorizontalBarDatum } from "../../components/charts/HorizontalBarChart";
import { SEVERITY_TOKENS } from "../../lib/palette";
import { SeverityChip, SlideOver } from "../../components/ui";
import type { DashboardTopSoftware } from "../../lib/api";
import { toGroupedVulnerabilities } from "./links";

export function TopSoftwareCard({
  topSoftware,
  isLoading,
}: {
  topSoftware: DashboardTopSoftware[];
  isLoading: boolean;
}) {
  const [selected, setSelected] = useState<DashboardTopSoftware | null>(null);

  const data: HorizontalBarDatum[] = topSoftware.map((row) => ({
    key: row.software,
    label: row.displayName,
    value: row.affectedDeviceCount,
    fill: SEVERITY_TOKENS[row.severity].fill,
  }));

  return (
    <>
      <ChartCard
        title="Top vulnerable software"
        subtitle="By affected devices"
        height={240}
        isLoading={isLoading}
        isEmpty={topSoftware.length === 0}
        emptyNote="No affected software."
      >
        <HorizontalBarChart
          data={data}
          onSelect={(d) => {
            const row = topSoftware.find((r) => r.software === d.key);
            if (row) setSelected(row);
          }}
        />
      </ChartCard>
      <SlideOver
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected?.displayName ?? ""}
        subtitle="Software"
      >
        {selected && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <SeverityChip severity={selected.severity} />
              <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                {selected.affectedDeviceCount} affected devices
              </span>
              <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                {selected.cveCount} {selected.cveCount === 1 ? "CVE" : "CVEs"}
              </span>
            </div>
            <Link
              to={toGroupedVulnerabilities()}
              className="block text-center text-xs font-medium text-indigo-600 hover:text-indigo-700"
            >
              View full detail →
            </Link>
          </div>
        )}
      </SlideOver>
    </>
  );
}
