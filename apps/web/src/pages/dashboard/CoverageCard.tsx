import { useNavigate } from "react-router-dom";
import { ChartCard } from "../../components/charts/ChartCard";
import { DonutChart, type DonutDatum } from "../../components/charts/DonutChart";
import { COVERAGE_TOKENS } from "../../lib/palette";
import type { CatalogCoverage } from "../../lib/api";
import { toCatalog, toCatalogStatus } from "./links";

export function CoverageCard({
  coverage,
  isLoading,
}: {
  coverage: CatalogCoverage | undefined;
  isLoading: boolean;
}) {
  const nav = useNavigate();
  const total = coverage?.total ?? 0;

  const data: DonutDatum[] = coverage
    ? [
        { key: "covered", label: COVERAGE_TOKENS.covered.label, value: coverage.covered, fill: COVERAGE_TOKENS.covered.fill },
        { key: "uncovered", label: COVERAGE_TOKENS.uncovered.label, value: coverage.uncovered, fill: COVERAGE_TOKENS.uncovered.fill },
        { key: "os", label: COVERAGE_TOKENS.os.label, value: coverage.os, fill: COVERAGE_TOKENS.os.fill },
      ]
    : [];

  return (
    <ChartCard
      title="Catalog coverage"
      subtitle="Winget remediation coverage across affected software"
      to={toCatalog()}
      height={220}
      isLoading={isLoading}
      isEmpty={total === 0}
      emptyNote="No software groups yet."
    >
      <DonutChart
        data={data}
        centerValue={total}
        centerLabel="Software"
        onSelect={(d) => nav(toCatalogStatus(d.key as "covered" | "uncovered" | "os"))}
      />
    </ChartCard>
  );
}
