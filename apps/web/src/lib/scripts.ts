import type { ScriptType } from "./api";

/**
 * Everything that varies per script type in one place — the label the table and
 * the Run Now picker show, the extension a per-row Download gets, and the
 * placeholder the upload textarea shows.
 *
 * Shared between ScriptCatalog.tsx and RunNowModal.tsx's ScriptPicker so the two
 * can't drift: the picker disables non-PowerShell entries (Intune's
 * deviceHealthScripts accepts PowerShell alone) and needs the same labels the
 * catalog uses.
 */
export const SCRIPT_TYPES: ReadonlyArray<{
  value: ScriptType;
  label: string;
  ext: string;
  placeholder: string;
}> = [
  {
    value: "powershell",
    label: "PowerShell",
    ext: "ps1",
    placeholder: "#requires -RunAsAdministrator...",
  },
  { value: "cmd", label: "Command Prompt", ext: "cmd", placeholder: "@echo off..." },
  { value: "bash", label: "Bash", ext: "sh", placeholder: "#!/bin/bash..." },
];

export const SCRIPT_TYPE_LABELS: Record<ScriptType, string> = {
  powershell: "PowerShell",
  cmd: "Command Prompt",
  bash: "Bash",
};

/** Extension → type, for inferring the type of a file picked in the upload form. */
export const EXT_TO_SCRIPT_TYPE: Record<string, ScriptType> = {
  ps1: "powershell",
  psm1: "powershell",
  cmd: "cmd",
  bat: "cmd",
  sh: "bash",
};

export function scriptTypeExt(type: ScriptType): string {
  return SCRIPT_TYPES.find((t) => t.value === type)?.ext ?? "txt";
}

/**
 * The only script type Run Now can actually dispatch: the intune-remediation
 * channel maps to Microsoft's deviceHealthScripts, which is PowerShell-only.
 */
export function isDispatchableScript(type: ScriptType): boolean {
  return type === "powershell";
}

export const NON_POWERSHELL_REASON =
  "PowerShell only — Intune remediation scripts must be PowerShell";
