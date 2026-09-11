import type { ReactNode } from "react";

/**
 * Shared confirm-before-acting modal, extracted from the identical pattern
 * that was hand-rolled 7 times (AppRegistration.tsx, SetupPairing.tsx's
 * `EnableDemoModeAction`, Tenants.tsx, ScriptCatalog.tsx, Jobs.tsx, Users.tsx,
 * and Updates.tsx's rollback confirm). Not a context/portal system — just a
 * drop-in for new call sites; those seven existing copies are left as-is.
 *
 * Deliberately a real in-app modal rather than `window.confirm()`: that
 * silently no-ops under plenty of ordinary conditions (Chrome's "prevent
 * additional dialogs", automation, an embedding iframe) — same reasoning
 * Updates.tsx's rollback confirm and Tenants.tsx's pendingWrite modal give.
 *
 * `tone="neutral"` (slate) for a reversible/low-risk action, matching
 * `EnableDemoModeAction`; `tone="destructive"` (rose) for something that
 * can't be undone from the UI, matching `Updates.tsx`'s rollback confirm.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  pendingLabel,
  tone = "neutral",
  pending = false,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  /** Shown on the confirm button while `pending` is true. Defaults to
   *  `confirmLabel` with a trailing ellipsis. */
  pendingLabel?: string;
  tone?: "neutral" | "destructive";
  pending?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;

  const confirmButtonClass =
    tone === "destructive"
      ? "rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-50"
      : "rounded-md bg-slate-900 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-slate-900/40"
        onClick={() => !pending && onCancel()}
        aria-hidden
      />
      <div className="relative z-10 w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-2xl">
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
        <div className="mt-2 text-sm text-slate-600 dark:text-slate-300">{description}</div>
        {error && (
          <p className="mt-3 rounded-md bg-red-50 dark:bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-400">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={onCancel}
            className="rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm font-medium text-slate-600 dark:text-slate-300 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={onConfirm}
            className={confirmButtonClass}
          >
            {pending ? (pendingLabel ?? `${confirmLabel}…`) : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
