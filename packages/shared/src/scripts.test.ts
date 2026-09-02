import { describe, expect, it } from "vitest";
import {
  buildWin32CommandLines,
  chocolateyLiveResponseLibraryScript,
  chocolateyLiveResponsePreview,
  generateChocolateyRemediation,
  generateScriptDetect,
  generateWin32ScriptWrapperInstall,
  generateWin32ScriptWrapperUninstall,
  generateWingetDetect,
  generateWuaRemediationCom,
  isWin32Source,
  remediationScript,
  wingetLiveResponseLibraryScript,
  WIN32_SCRIPT_MARKER_KEY,
} from "./scripts.js";

describe("remediationScript", () => {
  it("emits a winget upgrade for an app finding with a mapped package", () => {
    const script = remediationScript({
      channel: "intune-remediation",
      wingetPackageId: "7zip.7zip",
      software: "7-Zip",
    });
    expect(script).toContain("winget upgrade --id 7zip.7zip");
    expect(script).not.toContain("Microsoft.Update.Session");
  });

  it("emits a native WUA COM script for an OS finding with a KB", () => {
    const script = remediationScript({
      channel: "expedited-quality-update",
      wingetPackageId: null,
      kbId: "5036893",
      software: "Microsoft Windows",
    });
    expect(script).toContain("Microsoft.Update.Session");
    expect(script).toContain("5036893");
  });

  it("falls back to a placeholder KB when none is supplied", () => {
    const script = remediationScript({
      channel: "live-response",
      wingetPackageId: null,
      software: "Microsoft Windows",
    });
    expect(script).toContain("0000000");
  });

  it("prefers winget over WUA when a package id is present", () => {
    const script = remediationScript({
      channel: "live-response",
      wingetPackageId: "Mozilla.Firefox",
      kbId: "5036893",
      software: "Mozilla Firefox",
    });
    expect(script).toContain("Mozilla.Firefox");
    expect(script).not.toContain("Microsoft.Update.Session");
  });

  it("emits the inline PREVIEW Chocolatey script for a not-supported app under Intune Remediation", () => {
    const script = remediationScript({
      channel: "intune-remediation",
      wingetPackageId: null,
      software: "FileZilla",
      source: "chocolatey",
      altPackageId: "filezilla",
    });
    expect(script).toContain("choco upgrade filezilla");
    expect(script).toContain("PREVIEW");
  });

  it("emits the real parameterized library-script invocation for Chocolatey under Live Response", () => {
    const script = remediationScript({
      channel: "live-response",
      wingetPackageId: null,
      software: "FileZilla",
      source: "chocolatey",
      altPackageId: "filezilla",
    });
    expect(script).toContain("PatchPilot-Chocolatey-<content-hash>.ps1");
    expect(script).toContain("Args       = upgrade filezilla");
    // The real library script body is appended, not the inline PREVIEW one.
    expect(script).not.toContain("PREVIEW: Chocolatey delivery is modeled in this build");
  });

  it("prefers an alternate source over the winget mapping when both are present", () => {
    // remediationScript() must check `source`/`altPackageId` first — a not-supported
    // app that also happens to carry a stale wingetPackageId must still route through
    // the engineer-chosen alternate, not silently fall back to winget.
    const script = remediationScript({
      channel: "live-response",
      wingetPackageId: "Some.StaleWingetId",
      software: "FileZilla",
      source: "chocolatey",
      altPackageId: "filezilla",
    });
    expect(script).toContain("Args       = upgrade filezilla");
    expect(script).not.toContain("Some.StaleWingetId");
  });
});

describe("generateChocolateyRemediation", () => {
  it("bootstraps choco only when absent, then upgrades the package", () => {
    const script = generateChocolateyRemediation({ packageId: "filezilla" });
    expect(script).toContain("if (-not (Get-Command choco -ErrorAction SilentlyContinue)) {");
    expect(script).toContain("choco upgrade filezilla -y --no-progress");
  });

  it("is explicitly marked PREVIEW, since Intune Remediation delivery stays simulated", () => {
    const script = generateChocolateyRemediation({ packageId: "filezilla" });
    expect(script).toContain("PREVIEW: Chocolatey delivery is modeled in this build (no live repo call).");
  });
});

/**
 * The Chocolatey counterpart to the winget library-script contract above: never
 * trust choco's own exit code for "did this actually change/succeed" — diff the
 * installed version before and after — and publish the same PatchPilot-Exit
 * sentinel, since Defender's own exit_code does not carry the real one.
 */
describe("chocolateyLiveResponseLibraryScript", () => {
  const script = chocolateyLiveResponseLibraryScript();

  const statements = script
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  it("only supports the upgrade verb, rejecting anything else with code 2", () => {
    expect(script).toContain("if ($verb -ne 'upgrade') {");
    expect(script).toContain("Complete-PatchPilotRun -Code 2 -Message \"unsupported or missing verb");
  });

  it("requires a package id argument, failing with code 2 when absent", () => {
    expect(script).toContain("Complete-PatchPilotRun -Code 2 -Message 'no package id argument supplied for upgrade.'");
  });

  it("fails with code 3 when choco.exe cannot be resolved even after bootstrapping", () => {
    expect(script).toContain("Complete-PatchPilotRun -Code 3 -Message 'choco.exe not found and the bootstrap install did not produce it.'");
  });

  it("resolves the absolute choco.exe path instead of trusting $env:Path/Get-Command", () => {
    expect(script).toContain("$choco = Join-Path $env:ProgramData 'chocolatey\\bin\\choco.exe'");
    expect(script).not.toContain("Get-Command choco");
  });

  it("falls back to the Syncro RMM agent's bundled choco.exe before bootstrapping a fresh install", () => {
    const syncroCheckAt = script.indexOf("Kabuto_App_Manager\\bin\\choco.exe");
    const bootstrapAt = script.indexOf("community.chocolatey.org/install.ps1");
    expect(syncroCheckAt).toBeGreaterThan(-1);
    expect(syncroCheckAt).toBeLessThan(bootstrapAt);
  });

  it("measures the installed version on both sides of the upgrade", () => {
    const beforeAt = script.indexOf("$before = Get-PatchPilotChocoInstalledVersion");
    const upgradeAt = script.indexOf("& $choco upgrade");
    const afterAt = script.indexOf("$after = Get-PatchPilotChocoInstalledVersion");
    expect(beforeAt).toBeGreaterThan(-1);
    expect(beforeAt).toBeLessThan(upgradeAt);
    expect(upgradeAt).toBeLessThan(afterAt);
  });

  it("does not forward choco's exit code as the whole verdict", () => {
    expect(statements).not.toContain("exit $LASTEXITCODE");
    expect(statements).not.toContain("exit $chocoExit");
  });

  it("succeeds only when the installed version actually changed", () => {
    expect(script).toContain("if ($after -and $after -ne $before) {");
    expect(script).toContain('Complete-PatchPilotRun -Code 0 -Message "$packageId installed/upgraded');
  });

  it("distinguishes a clean no-op (5) from already-newest (6) from choco's own failure code", () => {
    expect(script).toContain("Complete-PatchPilotRun -Code 6 -Message \"$packageId is already at the newest version");
    expect(script).toContain('Complete-PatchPilotRun -Code $chocoExit -Message "choco exited $chocoExit and $packageId was not installed/upgraded."');
    expect(script).toContain("Complete-PatchPilotRun -Code 5 -Message @(");
  });

  it("publishes its verdict on stdout, because Defender does not report the exit code", () => {
    expect(script).toContain('Write-Output "PatchPilot-Exit: $Code"');
  });

  it("has no per-user scheduled-task routing, since Chocolatey always installs machine-wide", () => {
    expect(script).not.toContain("scheduled task");
    expect(script).not.toContain("Invoke-PatchPilotUserContextUpgrade");
  });

  it("passes --no-progress and -y so the call is silent and non-interactive", () => {
    expect(script).toContain("upgrade $packageId -y --no-progress");
  });
});

describe("chocolateyLiveResponsePreview", () => {
  it("shows the real RunScript invocation against the content-addressed library script", () => {
    const preview = chocolateyLiveResponsePreview("filezilla");
    expect(preview).toContain("ScriptName = PatchPilot-Chocolatey-<content-hash>.ps1");
    expect(preview).toContain("Args       = upgrade filezilla");
  });

  it("appends the full library script body, so the preview matches what actually runs", () => {
    const preview = chocolateyLiveResponsePreview("filezilla");
    expect(preview).toContain(chocolateyLiveResponseLibraryScript());
  });
});

/**
 * These assert the *shape* of the emitted PowerShell, which is as far as a TS test
 * can go — the semantics only exist once PowerShell runs it on a device. They exist
 * because the detect script previously pattern-matched the version against raw
 * `winget list` output (`$installed -match '24.08'`), which was wrong in both
 * directions, and nothing in the suite would have caught a regression back to it.
 */
describe("generateWingetDetect", () => {
  it("carries the package id and min version as quoted variables, not bare interpolations", () => {
    const script = generateWingetDetect({ packageId: "7zip.7zip", minVersion: "24.08" });
    expect(script).toContain("$packageId  = '7zip.7zip'");
    expect(script).toContain("$minVersion = '24.08'");
  });

  it("compares versions instead of pattern-matching the version string", () => {
    const script = generateWingetDetect({ packageId: "7zip.7zip", minVersion: "24.08" });
    // The old form treated the version's dots as regex wildcards AND reported a
    // NEWER install as non-compliant, because a newer version contains no literal match.
    expect(script).not.toMatch(/-match\s+'\$?\{?minVersion/);
    expect(script).not.toContain("-match '24.08'");
    expect(script).toContain("$compliant = $installedParsed -ge $minParsed");
  });

  it("pads both versions to four segments before comparing them", () => {
    const script = generateWingetDetect({ packageId: "7zip.7zip", minVersion: "24.08" });
    // A bare cast leaves omitted segments at -1, which sorts BELOW an explicit 0:
    // [version]'0.84' -ge [version]'0.84.0.0' is false, so a fully patched device was
    // told it needed remediation whenever the two strings had different segment counts.
    expect(script).not.toContain("[version]$installedVersion -ge [version]$minVersion");
    expect(script).toContain("while ($parts.Count -lt 4) { $parts = $parts + '0' }");
    expect(script).toContain("$installedParsed = ConvertTo-PatchPilotVersion");
    expect(script).toContain("$minParsed       = ConvertTo-PatchPilotVersion");
  });

  it("remediates rather than guessing when a version carries no numbers at all", () => {
    const script = generateWingetDetect({ packageId: "7zip.7zip", minVersion: "24.08" });
    // The old fallback was an ordinal STRING compare, which is not a version order:
    // it called an installed 'Unknown' compliant against any numeric minimum ('U'
    // sorts above '0'), reporting a vulnerable device green. It also called 1.10
    // older than 1.9. Nothing may fall back to string ordering here.
    expect(script).not.toContain("[StringComparison]::OrdinalIgnoreCase");
    expect(script).toContain("if ($null -eq $installedParsed -or $null -eq $minParsed)");
  });

  it("keeps the version parser silent, since output would join its return value", () => {
    const script = generateWingetDetect({ packageId: "7zip.7zip", minVersion: "24.08" });
    const start = script.indexOf("function ConvertTo-PatchPilotVersion");
    const body = script.slice(start, script.indexOf("\n}", start));
    expect(start).toBeGreaterThan(-1);
    expect(body).not.toContain("Write-Output");
    // ArrayList.Add returns the new index, which would land in the success stream too.
    expect(body).not.toContain(".Add(");
  });

  it("reads the version as the token after the id, not by splitting into columns", () => {
    const script = generateWingetDetect({ packageId: "7zip.7zip", minVersion: "24.08" });
    // Column splitting on runs of 2+ spaces silently failed on any row whose Name was
    // the widest in the table: winget then pads it with a single space and the row
    // collapses into one field. See the helper's own comment.
    expect(script).not.toContain("\\s{2,}");
    expect(script).toContain("[regex]::Split(([string]$line).Trim(), '\\s+')");
    expect(script).toContain("$tokens[$idIndex + 1]");
  });

  it("treats a missing install and an unreadable version as needing remediation", () => {
    const script = generateWingetDetect({ packageId: "7zip.7zip" });
    expect(script).toContain("if (-not $installedVersion)");
    // No minVersion supplied -> a floor everything satisfies, so presence alone passes.
    expect(script).toContain("$minVersion = '0.0.0'");
  });

  it("relaxes the error preference before invoking winget, so a stderr warning is not fatal", () => {
    // PS 5.1 escalates native stderr to a terminating error under 'Stop'; without
    // this the detect script dies before it can read winget's output at all.
    const script = generateWingetDetect({ packageId: "7zip.7zip", minVersion: "24.08" });
    const relaxAt = script.indexOf("$ErrorActionPreference = 'Continue'");
    // `$Winget` is the *parameter* of the shared Get-PatchPilotInstalledVersion helper;
    // the resolver's `$winget` is passed into it. Both scripts read the installed
    // version through that one helper, which is the point of it existing.
    const listAt = script.indexOf("& $Winget list");
    expect(relaxAt).toBeGreaterThan(-1);
    expect(listAt).toBeGreaterThan(-1);
    expect(relaxAt).toBeLessThan(listAt);
  });
});

/**
 * Live Response's KB remediation reported "failed" for every job regardless of
 * outcome, because this script never printed the `PatchPilot-Exit: <n>` sentinel
 * that `parseVerdict` (apps/worker/src/live-response.ts) requires — it only ever
 * called bare `exit 0` / `exit $result.ResultCode`. These lock in that both exit
 * paths now go through the same sentinel-emitting helper the winget/chocolatey
 * scripts already use, and that the WUA ResultCode maps onto it correctly.
 */
describe("generateWuaRemediationCom", () => {
  it("routes every exit through the PatchPilot-Exit sentinel, never a bare exit", () => {
    const script = generateWuaRemediationCom({ kbId: "5036893" });
    expect(script).toContain("function Complete-PatchPilotRun");
    expect(script).toContain('Write-Output "PatchPilot-Exit: $Code"');
    // The two bugged exit paths this replaces — neither may remain.
    expect(script).not.toContain("exit $result.ResultCode");
    expect(script).not.toMatch(/;\s*exit 0\b/);
  });

  it("reports the not-applicable/already-installed case as sentinel 0", () => {
    const script = generateWuaRemediationCom({ kbId: "5036893" });
    expect(script).toContain(
      "Complete-PatchPilotRun -Code 0 -Message 'KB5036893 not applicable or already installed.'",
    );
  });

  it("maps ResultCode 2 (Succeeded) to sentinel 0", () => {
    const script = generateWuaRemediationCom({ kbId: "5036893" });
    expect(script).toContain("if ($result.ResultCode -eq 2) {");
    const succeededBlock = script.slice(script.indexOf("if ($result.ResultCode -eq 2) {"));
    expect(succeededBlock).toContain("Complete-PatchPilotRun -Code 0");
  });

  it("forwards ResultCode 3 (SucceededWithErrors) as-is rather than folding it into success", () => {
    const script = generateWuaRemediationCom({ kbId: "5036893" });
    // The fallthrough after the ResultCode-2 branch forwards the raw code for
    // everything else, including 3 — a partial success must not read as green.
    expect(script).toContain("Complete-PatchPilotRun -Code $result.ResultCode -Message");
  });

  it("surfaces HResult in the message on both the success and non-success paths", () => {
    const script = generateWuaRemediationCom({ kbId: "5036893" });
    expect(script).toContain("$($result.HResult)");
  });
});

/**
 * The honesty contract of the Live Response library script. A job that patched or
 * removed nothing must not report success: winget exits 0 for "No available
 * upgrade found.", and the worker maps exit 0 straight to "succeeded", so a green
 * Jobs row appeared for a device that was still vulnerable. The upgrade/uninstall
 * verbs therefore decide their own verdict from the installed version before and
 * after; any other winget verb (list, search, ...) has no such notion and is
 * relayed with winget's own exit code instead. The worker's exit-code contract
 * (the PatchPilot-Exit sentinel) is left untouched either way.
 */
describe("wingetLiveResponseLibraryScript", () => {
  const script = wingetLiveResponseLibraryScript();

  /** Executable lines only. The script *talks about* winget's exit code and its
   *  "no upgrade" message in comments and diagnostics, which is fine and useful;
   *  what must not survive is either one driving the verdict. */
  const statements = script
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const controlFlow = statements.filter((line) => !line.startsWith("Write-Output"));

  // The three verb-specific sections, isolated so assertions about "the upgrade
  // path" don't accidentally match the same literal text inside the embedded
  // per-user child scripts (which share several of the same variable names).
  const upgradeBlockStart = script.indexOf("if ($verb -eq 'upgrade') {");
  const uninstallBlockStart = script.indexOf("if ($verb -eq 'uninstall') {");
  const fallbackStart = script.indexOf("# Any other winget verb");
  const upgradeBlock = script.slice(upgradeBlockStart, uninstallBlockStart);
  const uninstallBlock = script.slice(uninstallBlockStart, fallbackStart);
  const fallbackBlock = script.slice(fallbackStart);

  it("routes on the verb passed as the first Live Response argument", () => {
    expect(upgradeBlockStart).toBeGreaterThan(-1);
    expect(uninstallBlockStart).toBeGreaterThan(upgradeBlockStart);
    expect(fallbackStart).toBeGreaterThan(uninstallBlockStart);
  });

  it("does not forward winget's exit code as the whole verdict for upgrade/uninstall", () => {
    // The old tail. Exit 0 from winget meant "the command ran", never "the device
    // was patched" — conflating the two is the bug this whole block guards.
    expect(statements).not.toContain("exit $LASTEXITCODE");
  });

  it("measures the installed version on both sides of an upgrade", () => {
    expect(upgradeBlock).toContain("$before = Get-PatchPilotInstalledVersion");
    expect(upgradeBlock).toContain("$after = Get-PatchPilotInstalledVersion");
    const beforeAt = upgradeBlock.indexOf("$before = Get-PatchPilotInstalledVersion");
    const upgradeAt = upgradeBlock.indexOf("$winget upgrade");
    const afterAt = upgradeBlock.indexOf("$after = Get-PatchPilotInstalledVersion");
    expect(beforeAt).toBeLessThan(upgradeAt);
    expect(upgradeAt).toBeLessThan(afterAt);
  });

  it("succeeds only when the upgraded version actually changed", () => {
    expect(upgradeBlock).toContain("if ($after -and $after -ne $before) {");
    expect(upgradeBlock).toContain("Complete-PatchPilotRun -Code 0");
    // Code 5: winget was happy, the device is unchanged. Code 6: already on the
    // newest version available. Distinct from each other and from winget's own
    // failure codes so the transcript says which of the three happened.
    expect(upgradeBlock).toContain("Complete-PatchPilotRun -Code 5");
    expect(upgradeBlock).toContain("Complete-PatchPilotRun -Code 6");
  });

  it("measures the installed version on both sides of an uninstall", () => {
    expect(uninstallBlock).toContain("$before = Get-PatchPilotInstalledVersion");
    expect(uninstallBlock).toContain("$after = Get-PatchPilotInstalledVersion");
    const beforeAt = uninstallBlock.indexOf("$before = Get-PatchPilotInstalledVersion");
    const uninstallAt = uninstallBlock.indexOf("$winget uninstall");
    const afterAt = uninstallBlock.indexOf("$after = Get-PatchPilotInstalledVersion");
    expect(beforeAt).toBeLessThan(uninstallAt);
    expect(uninstallAt).toBeLessThan(afterAt);
  });

  it("succeeds only when the package actually became absent", () => {
    expect(uninstallBlock).toContain("if (-not $after) {");
    expect(uninstallBlock).toContain("Complete-PatchPilotRun -Code 0");
    expect(uninstallBlock).toContain("Complete-PatchPilotRun -Code 5");
    // Code 6: was already not installed before this ran. Compliant, not a failure.
    expect(uninstallBlock).toContain("Complete-PatchPilotRun -Code 6");
  });

  it("relays any other winget verb as-is, without the install/upgrade-only flag", () => {
    // --accept-package-agreements is rejected by winget as an unknown option on
    // verbs like list/search/show — it must not be appended unconditionally.
    expect(fallbackBlock).toContain("& $winget $verb @rawArgs --disable-interactivity --accept-source-agreements");
    expect(fallbackBlock).not.toContain("--accept-package-agreements");
    // No version check for these verbs — the verdict is winget's own exit code.
    expect(fallbackBlock).toContain("Complete-PatchPilotRun -Code $wingetExit");
  });

  it("publishes its verdict on stdout, because Defender does not report the exit code", () => {
    // A live run that ended `exit 4` came back from the API as exit_code 0 and the
    // job showed "Succeeded". The exit code does not travel off the device, so the
    // worker parses this line instead — see parseVerdict in live-response.ts.
    expect(script).toContain('Write-Output "PatchPilot-Exit: $Code"');
    // Every terminal path in THIS (SYSTEM) script goes through the helper, so none
    // can skip the sentinel. Both per-user child scripts (see USER_CONTEXT_CHILD_
    // SCRIPT and USER_CONTEXT_UNINSTALL_CHILD_SCRIPT) are separate, self-contained
    // scheduled-task scripts with their own JSON-result-file contract instead —
    // each legitimately owns its own bare exit(s), since Defender never captures
    // their output at all. Both are embedded unconditionally (the verb is chosen
    // at runtime from $args, not when this text is generated).
    const exits = statements.filter((line) => /^exit\b/.test(line));
    expect(exits).toEqual(["exit $Code", "exit 3", "exit 3", "exit 6"]);
  });

  it("reaches the no-op verdict by measuring, not by matching winget's message", () => {
    // That string is localized and has changed between winget releases; a check
    // built on it would start silently passing again the moment either changed.
    expect(controlFlow.join("\n")).not.toContain("No available upgrade found");
  });

  it("passes --include-unknown so an unreadable installed version is still upgradable", () => {
    // Without it winget refuses to upgrade a package whose ARP version reads
    // "Unknown" — it can't prove the candidate is newer — and exits 0 having
    // done nothing, which is exactly the silent no-op above.
    expect(script).toContain("--include-unknown");
  });

  it("stops only when there is no verb, no package id, or no winget to run", () => {
    expect(script).toContain("Complete-PatchPilotRun -Code 2 -Message 'no winget verb argument supplied.'");
    expect(script).toContain("no package id argument supplied for '$verb'");
    expect(script).toContain("Complete-PatchPilotRun -Code 3 -Message 'winget.exe not found under WindowsApps.'");
  });

  it("attempts the upgrade even when winget cannot report an installed version", () => {
    // The removed pre-flight gate called an empty `winget list` a per-user (HKCU)
    // install invisible to SYSTEM and refused to run. It fired on Remote Desktop
    // Manager, which is installed machine-wide under Program Files — so the gate was
    // blocking upgrades on a wrong diagnosis and the diagnosis text went with it.
    expect(script).not.toContain("per-user (HKCU) install");
    // The three "stop entirely" paths (no verb, no package id, no winget.exe) all
    // land before the direct-SYSTEM upgrade/uninstall calls — the embedded per-user
    // child scripts use a different function name (Write-PatchPilotChildResult), so
    // they don't participate in this count.
    const upgradeAt = upgradeBlock.lastIndexOf("$winget upgrade");
    const stopPaths = [...script.matchAll(/Complete-PatchPilotRun -Code [23]\b/g)];
    expect(stopPaths).toHaveLength(3);
    for (const stop of stopPaths) expect(stop.index).toBeLessThan(upgradeBlockStart + upgradeAt);
  });

  it("never re-registers the AppX package, which SYSTEM is refused outright", () => {
    // 0x80073CF9: "the Local System account is not allowed to perform this
    // operation". It could never succeed here, and winget ran fine without it.
    expect(script).not.toContain("Add-AppxPackage");
  });

  it("mocks a system profile for winget before touching it, but only on the direct-SYSTEM path", () => {
    // winget is an MSIX app: it expects a real interactive profile for its token
    // cache/telemetry/source database, which SYSTEM's own profile doesn't have, and
    // fails outright without one. This must run before the first SYSTEM-direct
    // resolver/winget call, but not before the early return into the per-user
    // scheduled-task path (Invoke-PatchPilotUserContextUpgrade), which already runs
    // under a real logged-on user's own profile.
    const mockAt = script.indexOf("$env:LOCALAPPDATA = 'C:\\Windows\\System32\\config\\systemprofile\\AppData\\Local'");
    const userBranchAt = script.indexOf("Invoke-PatchPilotUserContextUpgrade -PackageId $packageId");
    const resolverAt = script.lastIndexOf("$wingetDir = Get-ChildItem");
    expect(mockAt).toBeGreaterThan(-1);
    expect(userBranchAt).toBeLessThan(mockAt);
    expect(mockAt).toBeLessThan(resolverAt);
    // Both embedded per-user child scripts have their own copy of the resolver text
    // and must NOT be mocked to systemprofile - only one mock block exists in the
    // whole library script, appearing after both child scripts' own text.
    const mockOccurrences = script.split("$env:LOCALAPPDATA = 'C:\\Windows\\System32\\config\\systemprofile\\AppData\\Local'").length - 1;
    expect(mockOccurrences).toBe(1);
  });

  it("prints the raw listing from outside the function, not inside it", () => {
    // Anything a PowerShell function writes to the success stream joins its return
    // value, so a Write-Output diagnostic inside the helper would corrupt the version
    // string it returns. Hence the script-scoped stash, printed by the caller.
    expect(script).toContain("$script:PatchPilotListing = & $Winget list");
    // lastIndexOf: this same function is also embedded (with the same literal
    // signature) inside both per-user child scripts, earlier in the text — the
    // direct-SYSTEM copy this test is about is the final one.
    const fnStart = script.lastIndexOf("function Get-PatchPilotInstalledVersion");
    const fnEnd = upgradeBlockStart;
    // Executable lines only — the body's own comment explains the rule it follows.
    const body = script
      .slice(fnStart, fnEnd)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => !line.startsWith("#"));
    expect(body.join("\n")).not.toContain("Write-Output");
    expect(script.indexOf("$script:PatchPilotListing | ForEach-Object")).toBeGreaterThan(fnEnd);
  });
});

describe("isWin32Source", () => {
  it("accepts exactly the three known Win32 sources", () => {
    expect(isWin32Source("winget")).toBe(true);
    expect(isWin32Source("chocolatey")).toBe(true);
    expect(isWin32Source("script")).toBe(true);
  });

  it("rejects anything else, including the unrelated PackageSource value", () => {
    expect(isWin32Source("microsoft-store")).toBe(false);
    expect(isWin32Source("")).toBe(false);
    expect(isWin32Source(undefined)).toBe(false);
    expect(isWin32Source(42)).toBe(false);
  });
});

/**
 * A raw catalogued script has no package-manager id and no installed-version
 * signal, so the install wrapper's own registry marker is the only proof of
 * "this exact content already ran successfully" — these tests pin the
 * content-addressed contract between the install wrapper (writes the marker)
 * and the detect script (reads it back), since the two must agree on the
 * exact key/value shape without sharing any runtime state.
 */
describe("generateWin32ScriptWrapperInstall", () => {
  const input = {
    scriptCatalogEntryId: "entry-123",
    scriptContent: "Write-Output 'installing thing'",
    contentHash: "abc123hash",
  };

  it("embeds the raw script content directly, since there is no package id to hand to a wrapper CLI", () => {
    const script = generateWin32ScriptWrapperInstall(input);
    expect(script).toContain(input.scriptContent);
  });

  it("only writes the success marker after the embedded script's try block, not before it", () => {
    const script = generateWin32ScriptWrapperInstall(input);
    const tryAt = script.indexOf("try {");
    const contentAt = script.indexOf(input.scriptContent);
    const markerAt = script.indexOf("New-ItemProperty");
    expect(tryAt).toBeLessThan(contentAt);
    expect(contentAt).toBeLessThan(markerAt);
  });

  it("catches a thrown error from the embedded script and exits 1 without reaching the marker write", () => {
    const script = generateWin32ScriptWrapperInstall(input);
    const catchAt = script.indexOf("} catch {");
    const exit1At = script.indexOf("exit 1");
    const markerAt = script.indexOf("New-ItemProperty");
    expect(catchAt).toBeGreaterThan(-1);
    expect(catchAt).toBeLessThan(exit1At);
    expect(exit1At).toBeLessThan(markerAt);
  });

  it("writes the marker under the shared Win32Scripts key, valued with the current content hash", () => {
    const script = generateWin32ScriptWrapperInstall(input);
    expect(script).toContain(`Path '${WIN32_SCRIPT_MARKER_KEY}'`);
    expect(script).toContain(`$ScriptCatalogEntryId = '${input.scriptCatalogEntryId}'`);
    expect(script).toContain(`$ContentHash = '${input.contentHash}'`);
    expect(script).toContain("-Name $ScriptCatalogEntryId -Value $ContentHash");
  });

  it("exits 0 only after the marker write, matching the win32LobApp installCommandLine success contract", () => {
    const script = generateWin32ScriptWrapperInstall(input);
    const markerAt = script.indexOf("New-ItemProperty");
    const exit0At = script.lastIndexOf("exit 0");
    expect(exit0At).toBeGreaterThan(markerAt);
  });
});

describe("generateWin32ScriptWrapperUninstall", () => {
  it("only removes PatchPilot's own marker value, since an arbitrary script has no defined undo action", () => {
    const script = generateWin32ScriptWrapperUninstall({ scriptCatalogEntryId: "entry-123" });
    expect(script).toContain(`Remove-ItemProperty -Path '${WIN32_SCRIPT_MARKER_KEY}' -Name $ScriptCatalogEntryId`);
    expect(script).toContain("exit 0");
  });

  it("scopes the removal to its own entry id, leaving other entries' markers under the same key untouched", () => {
    const script = generateWin32ScriptWrapperUninstall({ scriptCatalogEntryId: "entry-123" });
    expect(script).toContain("$ScriptCatalogEntryId = 'entry-123'");
    expect(script).not.toContain("Remove-Item -Path");
  });
});

describe("generateScriptDetect", () => {
  const input = { scriptCatalogEntryId: "entry-123", contentHash: "abc123hash" };

  it("reports needs-remediation (exit 1) when the marker key doesn't exist at all", () => {
    const script = generateScriptDetect(input);
    const missingKeyAt = script.indexOf("-not (Test-Path");
    const exit1AfterKeyCheck = script.indexOf("exit 1", missingKeyAt);
    expect(missingKeyAt).toBeGreaterThan(-1);
    expect(exit1AfterKeyCheck).toBeGreaterThan(missingKeyAt);
  });

  it("reports needs-remediation when the key exists but no value is recorded for this entry", () => {
    const script = generateScriptDetect(input);
    expect(script).toContain("if (-not $actual) {");
  });

  it("compares the recorded marker against the current content hash, not a hardcoded expectation", () => {
    const script = generateScriptDetect(input);
    expect(script).toContain(`$ExpectedHash = '${input.contentHash}'`);
    expect(script).toContain("if ($actual -eq $ExpectedHash) {");
  });

  it("exits 0 only on a matching hash, and exits 1 on a stale (edited-since-install) marker", () => {
    const script = generateScriptDetect(input);
    const matchAt = script.indexOf("if ($actual -eq $ExpectedHash) {");
    const exit0At = script.indexOf("exit 0", matchAt);
    const staleExit1At = script.lastIndexOf("exit 1");
    expect(exit0At).toBeGreaterThan(matchAt);
    expect(staleExit1At).toBeGreaterThan(exit0At);
  });
});

describe("buildWin32CommandLines with source: \"script\"", () => {
  it("takes neither packageId nor winget/Chocolatey-only options on the command line, since content is baked into the wrapper", () => {
    const { installCommandLine, uninstallCommandLine } = buildWin32CommandLines({
      source: "script",
      packageId: "entry-123",
      installChoco: true,
      customRepo: "https://example.com/repo",
      customArguments: "--should-not-appear",
    });
    expect(installCommandLine).not.toContain("entry-123");
    expect(installCommandLine).not.toContain("--should-not-appear");
    expect(installCommandLine).not.toContain("example.com");
    expect(uninstallCommandLine).not.toContain("entry-123");
  });

  it("still invokes install.ps1/uninstall.ps1 by the same fixed setup file names as the other sources", () => {
    const { installCommandLine, uninstallCommandLine } = buildWin32CommandLines({
      source: "script",
      packageId: "entry-123",
      installChoco: false,
    });
    expect(installCommandLine).toContain("install.ps1");
    expect(uninstallCommandLine).toContain("uninstall.ps1");
  });
});
