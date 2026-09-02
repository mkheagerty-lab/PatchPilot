import { useEffect, useRef, useState } from "react";

/**
 * Button + option list, closes on outside-click or Escape — matches
 * TenantSwitcher.tsx's popover pattern (rootRef + mousedown listener). Built
 * for the Windows Updates hub's two "Create ▾" buttons, each with a single
 * option today but shaped as a list so a second create path (e.g. a
 * "quality-update" write path, if Graph ever exposes one) has somewhere to go.
 */

export interface DropdownButtonOption {
  key: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

export function DropdownButton({
  label,
  options,
  disabled,
}: {
  label: string;
  options: DropdownButtonOption[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-50"
      >
        {label}
        <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden className="h-3.5 w-3.5">
          <path
            fillRule="evenodd"
            d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z"
            clipRule="evenodd"
          />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-56 rounded-md border border-slate-200 bg-white py-1 shadow-lg"
        >
          {options.map((opt) => (
            <button
              key={opt.key}
              type="button"
              role="menuitem"
              disabled={opt.disabled}
              onClick={() => {
                setOpen(false);
                opt.onSelect();
              }}
              className="block w-full px-3 py-1.5 text-left text-sm text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
