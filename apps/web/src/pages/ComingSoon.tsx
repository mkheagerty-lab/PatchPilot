import { PageHeader, Card } from "../components/ui";

export function ComingSoon({
  title,
  phase,
}: {
  title: string;
  phase: string;
}) {
  return (
    <div>
      <PageHeader title={title} />
      <Card className="border-dashed">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-semibold text-indigo-700">
            {phase}
          </span>
          <p className="text-sm text-slate-500">
            This screen is part of the {title.toLowerCase()} workflow and will be
            wired up in {phase}.
          </p>
        </div>
      </Card>
    </div>
  );
}
