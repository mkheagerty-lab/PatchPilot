/**
 * Script generators ported 1:1 from the validated PatchPilot prototype.
 * These emit real, deployable PowerShell for Intune Remediations and
 * Defender Live Response. Keep output byte-for-byte reviewable by engineers.
 */
import type { RemediationChannel } from "./channels.js";
import type { PackageSource } from "./sources.js";
import type { InstallScope } from "./winget.js";

export interface WingetTarget {
  /** Winget package id, e.g. "7zip.7zip". */
  packageId: string;
  /** Minimum acceptable version for the detect script, e.g. "24.08". */
  minVersion?: string;
}

export interface WuaTarget {
  /** KB article id without the "KB" prefix, e.g. "5036893". */
  kbId: string;
}

/**
 * Locates winget.exe under WindowsApps and primes its source index, then gets out
 * of the way. `winget source update` runs first so the real command isn't the one
 * paying for a cold source fetch, and its failure is reported rather than swallowed
 * — a source index that didn't refresh is a leading cause of a device being told
 * there is nothing newer when there is.
 *
 * There is deliberately NO `Add-AppxPackage -Register` step. It was here on the
 * theory that the App Installer package is only *activated* for interactively
 * logged-on users, so SYSTEM needed to re-register it before invoking the exe. Live
 * runs disproved that: SYSTEM is refused outright (`0x80073CF9`, "the Local System
 * account is not allowed to perform this operation"), and winget then ran correctly
 * anyway. So the step never once succeeded, could never succeed in this context, and
 * only added a scary-looking failure to every transcript.
 *
 * The trap this DOES still avoid, because it broke live runs: WindowsApps holds
 * SEVERAL `Microsoft.DesktopAppInstaller_*` directories and only one is the real
 * package. The others are resource stubs — recognisable by the `_neutral_~_` in the
 * name, where `~` marks a resource package — and contain no `winget.exe`. Picking by
 * `Sort-Object Name -Descending` chose a stub, because a version like `2026.623.1704.0`
 * sorts above the real `1.29.x` as a *string*. So the only safe selector is "the
 * directory that actually contains winget.exe", with the version parsed as a
 * `[version]` (name-sorting also gets 1.9 vs 1.10 wrong).
 */
const WINGET_RESOLVER = `$wingetDir = Get-ChildItem -Path "$env:ProgramFiles\\WindowsApps" \`
  -Filter 'Microsoft.DesktopAppInstaller_*' -Directory -ErrorAction SilentlyContinue |
  Where-Object { Test-Path (Join-Path $_.FullName 'winget.exe') } |
  Sort-Object { try { [version](($_.Name -split '_')[1]) } catch { [version]'0.0.0.0' } } -Descending |
  Select-Object -First 1
$winget = $null
if ($wingetDir) {
  $winget = Join-Path $wingetDir.FullName 'winget.exe'
  Write-Output "PatchPilot: using $winget"
  $priorEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $srcUpdate = & $winget source update --disable-interactivity 2>&1
  if ($LASTEXITCODE -ne 0) {
    # Do NOT swallow this. A source index that failed to refresh is a leading cause
    # of "No available upgrade found." on a device that genuinely is out of date,
    # and suppressing the output made that indistinguishable from a real no-op.
    Write-Output "PatchPilot: 'winget source update' failed (exit $LASTEXITCODE) - the local package index may be stale:"
    $srcUpdate | ForEach-Object { Write-Output ([string]$_) }
  }
  $ErrorActionPreference = $priorEap
}`;

/**
 * winget resolver for the per-user scheduled-task child scripts
 * (`USER_CONTEXT_CHILD_SCRIPT`/`USER_CONTEXT_UNINSTALL_CHILD_SCRIPT`) — NOT
 * `WINGET_RESOLVER` above, which enumerates `Program Files\WindowsApps` and
 * only works there because SYSTEM (and admins) can list that directory.
 * Confirmed live: run under a standard signed-in user's own token, that
 * `Get-ChildItem` finds nothing — `Program Files\WindowsApps` denies
 * directory *listing* to a non-elevated user, even though winget genuinely
 * works fine when that same user runs it by hand from a prompt. It works by
 * hand because typing `winget` never enumerates that folder at all: it
 * resolves through a per-user App Execution Alias that Windows creates at a
 * fixed, user-owned path the moment App Installer is registered for that
 * profile. That path lives entirely inside the user's own `LOCALAPPDATA`,
 * so no elevated listing permission is needed to find it — and there is
 * exactly one such alias per user, so none of `WINGET_RESOLVER`'s
 * multiple-stub-directory version comparison applies here either.
 */
const USER_CONTEXT_WINGET_RESOLVER = `$winget = Join-Path $env:LOCALAPPDATA 'Microsoft\\WindowsApps\\winget.exe'
if (-not (Test-Path $winget)) {
  $winget = $null
} else {
  Write-Output "PatchPilot: using $winget"
  $priorEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $srcUpdate = & $winget source update --disable-interactivity 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Output "PatchPilot: 'winget source update' failed (exit $LASTEXITCODE) - the local package index may be stale:"
    $srcUpdate | ForEach-Object { Write-Output ([string]$_) }
  }
  $ErrorActionPreference = $priorEap
}`;

/**
 * PowerShell 5.1 — what both Intune Remediation and Live Response run — escalates
 * anything a native exe writes to stderr into a terminating `NativeCommandError`
 * when `$ErrorActionPreference` is `'Stop'`, and redirecting the stream does NOT
 * prevent it: the error record is raised before the redirection consumes it, so
 * only the preference itself helps. winget writes routine warnings to stderr, so
 * under `'Stop'` a warning aborts the script and we lose the real exit code — the
 * script's own `exit $LASTEXITCODE` never runs. Every native winget invocation is
 * therefore preceded by this; cmdlet errors before it stay fatal on purpose.
 */
const RELAX_FOR_NATIVE_CALL = `# PS 5.1 turns native stderr into a terminating error under 'Stop' (redirection does
# not prevent it), so a routine winget warning would abort the run before the exit
# code is read. Cmdlet errors above this point stayed fatal deliberately.
$ErrorActionPreference = 'Continue'`;

/**
 * winget is an MSIX-packaged app: it expects a real interactive user profile for its
 * token cache, telemetry, and source-index database under `$env:LOCALAPPDATA`, and
 * SYSTEM's own profile has none of that set up. Live runs showed winget failing
 * outright when invoked directly as SYSTEM for exactly this reason — confirmed
 * against real job transcripts, not just the theory. Pointing `LOCALAPPDATA`/
 * `USERPROFILE` at the OS's own systemprofile directory (and pre-creating winget's
 * `LocalState` folder under it) gives winget a real profile to read/write while the
 * call keeps running with SYSTEM's rights — nothing about *who* runs the command
 * changes, only what it takes to look like a profile.
 *
 * Deliberately absent from `USER_CONTEXT_CHILD_SCRIPT`/
 * `USER_CONTEXT_UNINSTALL_CHILD_SCRIPT`: those already run inside a real
 * interactively-logged-on user's own profile via the scheduled task, and pointing
 * them at systemprofile would break the entire reason that path exists.
 */
const MOCK_SYSTEM_PROFILE = `# winget expects an interactive user profile (token cache, telemetry, source
# index) that SYSTEM's own profile does not have, and fails outright without one.
# Point it at the OS's built-in system profile directory instead - this satisfies
# that requirement while the call still runs with SYSTEM's rights.
$env:LOCALAPPDATA = 'C:\\Windows\\System32\\config\\systemprofile\\AppData\\Local'
$env:USERPROFILE = 'C:\\Windows\\System32\\config\\systemprofile'
$systemWingetState = Join-Path $env:LOCALAPPDATA 'Packages\\Microsoft.DesktopAppInstaller_8wekyb3d8bbwe\\LocalState'
if (-not (Test-Path $systemWingetState)) {
  New-Item -ItemType Directory -Path $systemWingetState -Force | Out-Null
}`;

/**
 * Reads the version winget believes is installed, or `$null` if winget can't see the
 * package at all. Shared by the detect script and the Live Response remediation so
 * "is it compliant?" and "did the upgrade change anything?" are answered from the
 * same source rather than two subtly different parsers.
 *
 * Returning `$null` covers both "not installed" and "installed but winget can't
 * correlate it to the source package" — the caller cannot tell those apart from the
 * return value alone, which is why the raw listing is stashed for it to print. A
 * machine-wide install whose ARP entry doesn't match the package id lands here too,
 * so `$null` must never be read as "nothing to upgrade".
 */
const WINGET_INSTALLED_VERSION_FN = `# 'winget list' prints a column-padded table:  Name  Id  Version  [Available]  Source
# The version is read as the token immediately after the package id, NOT by splitting
# the row into columns. Column splitting looked right and was wrong: winget pads each
# column to its widest cell, so when the longest Name in the table IS this row's name,
# the gap after it collapses to a single space and the whole row becomes one field.
# That is not a rare shape - a single-result 'list --id X --exact' hits it whenever the
# name is longer than the header word 'Name', which is nearly always.
# The id is a whitespace-free token, so anchoring on it is immune to the padding. The
# LAST match on the line wins so a package whose Name is also its id still resolves.
function Get-PatchPilotInstalledVersion {
  param([string]$Winget, [string]$PackageId)
  # Diagnostics are stashed in script scope rather than written out here. Everything a
  # PowerShell function writes to the success stream becomes part of its return value,
  # so a Write-Output diagnostic in this body would corrupt the version string it
  # returns. The caller prints these when the lookup comes back empty.
  $script:PatchPilotListing = & $Winget list --id $PackageId --exact --source winget --accept-source-agreements --disable-interactivity 2>&1
  $script:PatchPilotListingExit = $LASTEXITCODE
  foreach ($line in $script:PatchPilotListing) {
    $tokens = [regex]::Split(([string]$line).Trim(), '\\s+')
    $idIndex = -1
    for ($i = 0; $i -lt $tokens.Count; $i++) { if ($tokens[$i] -eq $PackageId) { $idIndex = $i } }
    if ($idIndex -ge 0 -and $idIndex -lt ($tokens.Count - 1)) { return $tokens[$idIndex + 1] }
  }
  return $null
}`;

/**
 * Turns a winget/ARP version string into a comparable `[version]`, or `$null` when
 * there is no numeric version in it at all.
 *
 * Two traps live here, both of which produced a *wrong verdict* rather than an error:
 *
 * 1. A bare `[version]` cast leaves omitted segments at -1, and -1 sorts below an
 *    explicit 0 — so `[version]'0.84' -ge [version]'0.84.0.0'` is **false**. Any pair
 *    of version strings with different segment counts compared wrong, which is the
 *    common case: catalogs quote `0.84`, devices report `0.84.0.0`. A device that was
 *    fully patched got told it needed remediation. Padding to four segments makes the
 *    two spellings of the same version compare equal, which is what they mean.
 *
 * 2. Real versions carry text `[version]` rejects outright (`1.2.3-beta`, `24.09 (x64)`).
 *    The old code caught the cast failure and fell back to an ordinal *string* compare,
 *    which is not a version order at all: it called `1.10` older than `1.9`, and — much
 *    worse — called an installed `Unknown` compliant against any numeric minimum,
 *    because 'U' sorts above '0'. That is a silently vulnerable device reported green.
 *    Comparing the leading numeric run and reporting "no numeric version" separately
 *    keeps the failure visible instead of guessing.
 */
const VERSION_PARSE_FN = `# Returns a [version] padded to four segments, or $null when the string carries no
# numeric version. See ConvertTo-PatchPilotVersion's contract in scripts.ts.
function ConvertTo-PatchPilotVersion {
  param([string]$Value)
  # Nothing may be written to the success stream in here: it would join the return
  # value. The leading numeric run is all that is compared; any suffix is dropped.
  $match = [regex]::Match(([string]$Value).Trim(), '^\\d+(\\.\\d+){0,3}')
  if (-not $match.Success) { return $null }
  $parts = @($match.Value.Split('.'))
  while ($parts.Count -lt 4) { $parts = $parts + '0' }
  # A segment wider than Int32 still fails the cast, so the caller keeps a null path.
  try { return [version]($parts -join '.') } catch { return $null }
}`;

/**
 * `--disable-interactivity` makes winget fail fast on any prompt it can't satisfy
 * instead of hanging forever with no user session to answer it — the single
 * biggest risk factor for a SYSTEM-context run parking at "running" indefinitely.
 *
 * `--exact` pairs with the `--id` these flags are always used alongside: without it
 * winget substring-matches the id and refuses to act when that hits more than one
 * package ("multiple packages found matching input criteria"), which reads as an
 * opaque non-zero exit rather than the upgrade we asked for.
 *
 * `--include-unknown` covers packages whose *installed* version winget can't read
 * from the ARP entry and reports as "Unknown". Without it winget refuses to upgrade
 * them — it can't prove the candidate is newer — and reports "No available upgrade
 * found." with exit 0, which is exactly the silent no-op that made a job look
 * successful while nothing was patched.
 *
 * `--source winget` pins the query to the community repo PatchPilot actually
 * targets. Left unscoped, winget also queries `msstore`, which gates on a
 * separate "Terms of Transaction" agreement that `--accept-source-agreements`
 * does not satisfy and that `--disable-interactivity` can't prompt for — proven
 * live: a device with Chrome genuinely installed machine-wide under
 * `Program Files` still failed both the pre-check and the upgrade with "No
 * installed package found matching input criteria" because the un-consented
 * msstore source aborted correlation across every source, not just its own.
 */
const WINGET_UPGRADE_FLAGS =
  "--exact --silent --source winget --disable-interactivity --accept-source-agreements --accept-package-agreements --force --include-unknown";

/**
 * Same rationale as `WINGET_UPGRADE_FLAGS` for `--exact`/`--disable-interactivity`/
 * `--source winget`/`--force`/`--accept-source-agreements`. Two are deliberately
 * dropped: `--accept-package-agreements` gates a licensing prompt that only applies
 * to installing/upgrading a package, not removing one; `--include-unknown` is an
 * upgrade-only flag winget rejects on `uninstall` ("unknown option").
 */
const WINGET_UNINSTALL_FLAGS =
  "--exact --silent --source winget --disable-interactivity --accept-source-agreements --force";

/**
 * `install`, not `upgrade` — the Win32 wrapper scripts run through a
 * `win32LobApp`'s `installCommandLine`, which Intune only invokes after its
 * own detection rule has already reported the package absent. `winget
 * upgrade` operates only on a package it can already correlate to an
 * existing install and errors ("No installed package found matching input
 * criteria") on anything genuinely absent, so it is the wrong verb here —
 * unlike the Live Response library script above, which upgrades an app
 * Defender's own inventory already found present. Same `--exact`/`--silent`/
 * `--source winget`/`--disable-interactivity`/agreement-acceptance rationale
 * as `WINGET_UPGRADE_FLAGS`; `--include-unknown` is dropped because it is
 * upgrade-only (winget rejects it on `install`).
 */
const WINGET_INSTALL_FLAGS =
  "--exact --silent --source winget --disable-interactivity --accept-source-agreements --accept-package-agreements --force";

/**
 * Child script for the per-user scheduled-task upgrade path (see
 * `USER_CONTEXT_RUNNER`). winget's install scope follows the *running
 * account*, not a flag SYSTEM can pass it, so a per-user (HKCU) install is
 * invisible to SYSTEM no matter how it's invoked — this is written to disk
 * by the SYSTEM-context library script and actually run by a scheduled task
 * impersonating the interactively logged-on user.
 *
 * Reports back through a result file, not stdout: Defender Live Response
 * only captures the SYSTEM parent's own output stream, and this runs
 * detached in a different logon session under a different token.
 *
 * Deliberately self-contained (its own copies of the resolver/version-check
 * blocks) rather than a reference to a shared file — it's regenerated fresh
 * from the parent's in-memory string on every run and never uploaded
 * anywhere itself, so there is nothing to content-hash or reuse.
 */
const USER_CONTEXT_CHILD_SCRIPT = `$ErrorActionPreference = 'Stop'
$packageId = $args[0]
$resultPath = $args[1]
function Write-PatchPilotChildResult {
  param([int]$Code, [string]$Message)
  @{ Code = $Code; Message = $Message } | ConvertTo-Json -Compress | Set-Content -Path $resultPath -Encoding UTF8
}
try {
${USER_CONTEXT_WINGET_RESOLVER}
  if (-not $winget -or -not (Test-Path $winget)) {
    Write-PatchPilotChildResult -Code 3 -Message "no winget App Execution Alias found at $env:LOCALAPPDATA\\Microsoft\\WindowsApps\\winget.exe for this user - App Installer may not be registered for this profile."
    exit 3
  }
${RELAX_FOR_NATIVE_CALL}
${WINGET_INSTALLED_VERSION_FN}
  $wingetUpdateNotApplicable = -1978335189
  $before = Get-PatchPilotInstalledVersion -Winget $winget -PackageId $packageId
  & $winget upgrade --id $packageId ${WINGET_UPGRADE_FLAGS}
  $wingetExit = $LASTEXITCODE
  $after = Get-PatchPilotInstalledVersion -Winget $winget -PackageId $packageId
  if ($after -and $after -ne $before) {
    Write-PatchPilotChildResult -Code 0 -Message "$packageId upgraded '$before' -> '$after'."
  } elseif ($wingetExit -eq $wingetUpdateNotApplicable) {
    Write-PatchPilotChildResult -Code 6 -Message "$packageId is already at the newest version winget has available ('$after')."
  } elseif ($wingetExit -ne 0) {
    Write-PatchPilotChildResult -Code $wingetExit -Message "winget exited $wingetExit and $packageId was not upgraded."
  } else {
    Write-PatchPilotChildResult -Code 5 -Message 'winget reported no error, but the installed version did not change.'
  }
} catch {
  Write-PatchPilotChildResult -Code 1 -Message "user-context upgrade threw: $($_.Exception.Message)"
}
`;

/**
 * Registers, force-runs, and tears down the scheduled task that drives
 * `USER_CONTEXT_CHILD_SCRIPT` as the interactively logged-on user.
 *
 * Does NOT target that user by name. The obvious approach — read
 * `(Get-CimInstance Win32_ComputerSystem).UserName` and pass it as `schtasks
 * /RU` or a `New-ScheduledTaskPrincipal -UserId` — fails specifically on
 * Entra-joined (non-hybrid) devices: `Win32_ComputerSystem.UserName` reports
 * an Entra-joined sign-in as `AzureAD\<user>`, and neither `schtasks.exe` nor
 * `Register-ScheduledTask` can resolve that synthetic prefix to a real
 * principal — task creation fails as if the account didn't exist, even
 * though the user is signed in right now. This is a documented gap in
 * Entra-joined scheduled-task creation, not specific to PatchPilot.
 *
 * The workaround: a principal built from the built-in `Users` group SID
 * alone (`-GroupId 'S-1-5-32-545'`, locale-independent unlike the group's
 * display name) needs no account name to resolve at all — Task Scheduler
 * runs it as whichever member of that group currently holds an interactive
 * session, which on an ordinary device is exactly the one user this needs to
 * reach. `Win32_ComputerSystem.UserName` is kept only to detect "nobody is
 * signed in" up front and to name that user in messages.
 *
 * Deliberately no `-LogonType` and no `-RunLevel Highest` alongside
 * `-GroupId` — confirmed live, in that order:
 *   - `-GroupId` + `-LogonType Interactive` fails Register-ScheduledTask
 *     itself with "Parameter set cannot be resolved using the specified
 *     named parameters." `-LogonType` belongs to the `-UserId` parameter
 *     set, not the `-GroupId` one; a group principal has no separate logon
 *     type to specify; there is no combination of `-LogonType` values that
 *     makes this legal, so the parameter must be omitted entirely.
 *   - `-RunLevel Highest` was removed first on the reasoning that a
 *     `Group`-based principal has no single account for Task Scheduler to
 *     get UAC consent from, but that was never actually confirmed live —
 *     the `-LogonType` clash above turned out to be the sole cause of every
 *     "failed to register" report, including the one after `-RunLevel
 *     Highest` was already gone. Left out anyway: a per-user winget install
 *     was never going to need elevation in the first place.
 *
 * This also means the scheduled-task calls here are ordinary cmdlets, not
 * the native `schtasks.exe` — so none of them need the
 * `RELAX_FOR_NATIVE_CALL` stderr workaround; a cmdlet failure under
 * `$ErrorActionPreference = 'Stop'` already throws into the `catch` below.
 *
 * `$env:ProgramData` and a winget package id are both guaranteed
 * space-free, so the task's argument string is built without quoting.
 */
const USER_CONTEXT_RUNNER = `function Invoke-PatchPilotUserContextUpgrade {
  param([string]$PackageId)

  $runAsUser = (Get-CimInstance Win32_ComputerSystem).UserName
  if ([string]::IsNullOrWhiteSpace($runAsUser)) {
    return @{ Code = 7; Message = 'no interactively logged-on user was found on this device - a per-user install can only be upgraded while its owner is signed in.' }
  }

  $workDir = Join-Path $env:ProgramData 'PatchPilot'
  New-Item -ItemType Directory -Path $workDir -Force | Out-Null
  $token = [guid]::NewGuid().ToString('N')
  $childScriptPath = Join-Path $workDir "user-upgrade-$token.ps1"
  $resultPath = Join-Path $workDir "user-upgrade-$token.json"
  $taskName = "PatchPilot-UserUpgrade-$token"

  $childScript = @'
${USER_CONTEXT_CHILD_SCRIPT}
'@
  Set-Content -Path $childScriptPath -Value $childScript -Encoding UTF8
  $taskArgument = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File $childScriptPath $PackageId $resultPath"

  try {
    # Built-in 'Users' group (S-1-5-32-545) + Interactive logon type: runs as
    # whichever signed-in user is a member, without resolving 'AzureAD\\<user>' by
    # name - see this function's header comment for why that resolution fails.
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $taskArgument
    $principal = New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545'
    Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName

    $deadline = (Get-Date).AddSeconds(90)
    while (-not (Test-Path $resultPath) -and (Get-Date) -lt $deadline) {
      Start-Sleep -Seconds 3
    }
    if (-not (Test-Path $resultPath)) {
      return @{ Code = 8; Message = "timed out after 90s waiting for the per-user task to report back - it may still be running as '$runAsUser'." }
    }
    $parsed = Get-Content -Path $resultPath -Raw | ConvertFrom-Json
    return @{ Code = [int]$parsed.Code; Message = [string]$parsed.Message }
  } catch {
    return @{ Code = 8; Message = "failed to register or start the per-user scheduled task: $($_.Exception.Message)" }
  } finally {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item -Path $childScriptPath -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $resultPath -Force -ErrorAction SilentlyContinue
  }
}`;

/**
 * Uninstall counterpart to `USER_CONTEXT_CHILD_SCRIPT` — same rationale (winget's
 * scope follows the running account, so a per-user install can only be removed by
 * a task impersonating its owner), but the verdict is "is it gone?" rather than
 * "did the version change": code 6 means it was already absent (compliant with the
 * goal state, not a failure), code 0 means the uninstall actually removed it.
 */
const USER_CONTEXT_UNINSTALL_CHILD_SCRIPT = `$ErrorActionPreference = 'Stop'
$packageId = $args[0]
$resultPath = $args[1]
function Write-PatchPilotChildResult {
  param([int]$Code, [string]$Message)
  @{ Code = $Code; Message = $Message } | ConvertTo-Json -Compress | Set-Content -Path $resultPath -Encoding UTF8
}
try {
${USER_CONTEXT_WINGET_RESOLVER}
  if (-not $winget -or -not (Test-Path $winget)) {
    Write-PatchPilotChildResult -Code 3 -Message "no winget App Execution Alias found at $env:LOCALAPPDATA\\Microsoft\\WindowsApps\\winget.exe for this user - App Installer may not be registered for this profile."
    exit 3
  }
${RELAX_FOR_NATIVE_CALL}
${WINGET_INSTALLED_VERSION_FN}
  $before = Get-PatchPilotInstalledVersion -Winget $winget -PackageId $packageId
  if (-not $before) {
    Write-PatchPilotChildResult -Code 6 -Message "$packageId is not installed for this user; nothing to uninstall."
    exit 6
  }
  & $winget uninstall --id $packageId ${WINGET_UNINSTALL_FLAGS}
  $wingetExit = $LASTEXITCODE
  $after = Get-PatchPilotInstalledVersion -Winget $winget -PackageId $packageId
  if (-not $after) {
    Write-PatchPilotChildResult -Code 0 -Message "$packageId (was '$before') was uninstalled."
  } elseif ($wingetExit -ne 0) {
    Write-PatchPilotChildResult -Code $wingetExit -Message "winget exited $wingetExit and $packageId was not uninstalled."
  } else {
    Write-PatchPilotChildResult -Code 5 -Message 'winget reported no error, but the package is still installed.'
  }
} catch {
  Write-PatchPilotChildResult -Code 1 -Message "user-context uninstall threw: $($_.Exception.Message)"
}
`;

/**
 * Uninstall counterpart to `USER_CONTEXT_RUNNER` — same Builtin\\Users
 * (`S-1-5-32-545`) + Interactive-logon-type principal, for the same reason
 * (see that function's header comment: `Win32_ComputerSystem.UserName`
 * reports `AzureAD\\<user>` on Entra-joined devices, which neither
 * `schtasks.exe` nor `Register-ScheduledTask` can resolve as a named
 * principal). A separate task-name prefix (`PatchPilot-UserUninstall-`)
 * keeps it from colliding with a concurrent per-user upgrade task against
 * the same device/package.
 */
const USER_CONTEXT_UNINSTALL_RUNNER = `function Invoke-PatchPilotUserContextUninstall {
  param([string]$PackageId)

  $runAsUser = (Get-CimInstance Win32_ComputerSystem).UserName
  if ([string]::IsNullOrWhiteSpace($runAsUser)) {
    return @{ Code = 7; Message = 'no interactively logged-on user was found on this device - a per-user install can only be uninstalled while its owner is signed in.' }
  }

  $workDir = Join-Path $env:ProgramData 'PatchPilot'
  New-Item -ItemType Directory -Path $workDir -Force | Out-Null
  $token = [guid]::NewGuid().ToString('N')
  $childScriptPath = Join-Path $workDir "user-uninstall-$token.ps1"
  $resultPath = Join-Path $workDir "user-uninstall-$token.json"
  $taskName = "PatchPilot-UserUninstall-$token"

  $childScript = @'
${USER_CONTEXT_UNINSTALL_CHILD_SCRIPT}
'@
  Set-Content -Path $childScriptPath -Value $childScript -Encoding UTF8
  $taskArgument = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File $childScriptPath $PackageId $resultPath"

  try {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $taskArgument
    $principal = New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545'
    Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName

    $deadline = (Get-Date).AddSeconds(90)
    while (-not (Test-Path $resultPath) -and (Get-Date) -lt $deadline) {
      Start-Sleep -Seconds 3
    }
    if (-not (Test-Path $resultPath)) {
      return @{ Code = 8; Message = "timed out after 90s waiting for the per-user task to report back - it may still be running as '$runAsUser'." }
    }
    $parsed = Get-Content -Path $resultPath -Raw | ConvertFrom-Json
    return @{ Code = [int]$parsed.Code; Message = [string]$parsed.Message }
  } catch {
    return @{ Code = 8; Message = "failed to register or start the per-user scheduled task: $($_.Exception.Message)" }
  } finally {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item -Path $childScriptPath -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $resultPath -Force -ErrorAction SilentlyContinue
  }
}`;

/**
 * Winget remediation (third-party apps). Runs as SYSTEM via Intune Remediation
 * or Defender Live Response.
 */
export function generateWingetRemediation(target: WingetTarget): string {
  return `# PatchPilot - Winget remediation for ${target.packageId}
# Runs as SYSTEM via Intune Remediation or Live Response
$ErrorActionPreference = 'Stop'
${MOCK_SYSTEM_PROFILE}
${WINGET_RESOLVER}
${RELAX_FOR_NATIVE_CALL}
& $winget upgrade --id ${target.packageId} ${WINGET_UPGRADE_FLAGS}
exit $LASTEXITCODE
`;
}

/**
 * Winget uninstall (third-party apps). Runs as SYSTEM via Intune Remediation or
 * Defender Live Response. Sibling of `generateWingetRemediation` — same resolver
 * and native-call relaxation, `uninstall` in place of `upgrade`.
 */
export function generateWingetUninstall(target: WingetTarget): string {
  return `# PatchPilot - Winget uninstall for ${target.packageId}
# Runs as SYSTEM via Intune Remediation or Live Response
$ErrorActionPreference = 'Stop'
${MOCK_SYSTEM_PROFILE}
${WINGET_RESOLVER}
${RELAX_FOR_NATIVE_CALL}
& $winget uninstall --id ${target.packageId} ${WINGET_UNINSTALL_FLAGS}
exit $LASTEXITCODE
`;
}

/**
 * The single, parameterized winget script uploaded ONCE to a tenant's Defender Live
 * Response library and reused for every winget verb PatchPilot ever invokes there.
 * Defender only runs *library* scripts by name and cannot execute inline script
 * bodies, so PatchPilot provisions this one file and then invokes it by passing the
 * verb as the first Live Response argument (`RunScript` `Args`) — e.g. `"upgrade
 * 7zip.7zip"`, `"uninstall 7zip.7zip"`, or, for a per-user-scoped install, a third
 * `"user"` token (`"upgrade 7zip.7zip user"`). Reading everything from `$args` rather
 * than baking it into the body means one library file handles every winget app and
 * every verb, so a tenant is onboarded with a single upload and the file's content
 * never changes per call.
 *
 * `upgrade` and `uninstall` are first-class: they get a version-based verdict
 * (below), the per-user scheduled-task routing, and subcommand-correct flags. Any
 * other winget verb (`list`, `search`, `show`, ...) is relayed to winget as-is —
 * there's no "did it change" question for those, so the verdict is just winget's own
 * exit code, published through the same sentinel.
 *
 * Intentionally content-stable (no per-call interpolation): the executor derives the
 * library file name from a hash of this exact text, so an unchanged body maps to an
 * unchanged name and the "already uploaded?" check is an exact-name existence test.
 *
 * `upgrade`/`uninstall` decide their own success rather than forwarding winget's exit
 * code. This used to end `& $winget upgrade ...; exit $LASTEXITCODE`, and winget
 * exits 0 for "No available upgrade found." — so a run that patched nothing at all
 * reported exit 0, the worker mapped that to "succeeded", and the Jobs UI showed a
 * green row for a device that was still vulnerable. Comparing the installed version
 * before and after is the only claim we can actually stand behind.
 *
 * The no-op verdict is reached by *measuring the version*, deliberately not by
 * matching winget's "No available upgrade found." text: that string is localized and
 * has changed between winget releases, so a check built on it would silently start
 * passing again the moment either changed.
 *
 * "Already up to date" is its own verdict (exit 6), not a failure. winget's own exit
 * code for this case is non-zero - HRESULT 0x8A15002B / -1978335189
 * (APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE, confirmed against winget-cli's own
 * AppInstallerErrors.h) - so without this branch a device that is already compliant
 * reports the raw winget exit code and shows as Failed. Matched on the numeric HRESULT
 * rather than stdout text for the same localization reason as the version check above.
 *
 * The verdict travels in stdout, as a `PatchPilot-Exit: <n>` line, because Defender
 * does not report this script's exit code. Proven live: a run that ended `exit 4`
 * printed its exit-4-only messages into the transcript and still came back from the
 * API as `exit_code: 0`, so the job showed "Succeeded". `exit` is kept alongside the
 * sentinel for anyone running the file by hand, but nothing downstream reads it.
 *
 * There is deliberately no pre-flight gate on `upgrade`. An earlier version refused
 * to run it when `winget list` couldn't report an installed version, calling that a
 * per-user (HKCU) install invisible to SYSTEM. That diagnosis was wrong: it fired on
 * Remote Desktop Manager, which is installed machine-wide under Program Files. An
 * empty listing means winget failed to correlate the installed app to its source
 * package, which says nothing about whether the upgrade would work — so the script
 * shows what winget actually printed and tries the upgrade anyway.
 *
 * A per-user-scoped install (final `Args` token `"user"`) is NOT invisible in the
 * way the removed gate above assumed — it's reachable, just not from SYSTEM. Live
 * Response has no user-context execution mode of its own, so this branch hands the
 * actual `winget upgrade`/`uninstall` off to a short-lived scheduled task running as
 * the interactively logged-on user (`Invoke-PatchPilotUserContextUpgrade`/
 * `...Uninstall`), then relays that task's result through the same
 * `PatchPilot-Exit:` sentinel — the worker's parser does not need to know which path
 * produced it. Both runner functions are embedded regardless of which verb is
 * actually invoked, since the choice is made at runtime from `$args`, not when this
 * text is generated.
 */
export function wingetLiveResponseLibraryScript(): string {
  return `# PatchPilot - Winget Live Response library script (parameterized, generic)
# Runs as SYSTEM via Defender Live Response. Runs winget with the verb and arguments
# passed as Live Response Args:
#   <verb> <packageId> [user]    for 'upgrade' or 'uninstall' - the only two verbs
#                                 with a version-based verdict and per-user routing.
#                                 A trailing "user" token routes the call through a
#                                 scheduled task running as the signed-in user
#                                 instead of SYSTEM directly (see
#                                 Invoke-PatchPilotUserContextUpgrade/Uninstall).
#   <verb> [winget args...]      any other winget verb (list, search, show, ...) is
#                                 relayed to winget as-is.
# e.g. RunScript with Args "upgrade 7zip.7zip" or "uninstall 7zip.7zip user".
#
# The verdict is published as a 'PatchPilot-Exit: <n>' line on stdout, which is what
# the worker reads - Defender's own exit_code does NOT carry this script's exit code.
#   0 upgrade/uninstall: the installed state actually changed as requested
#   2 no verb, or no package id for upgrade/uninstall   3 winget.exe not found
#   5 winget ran cleanly but the installed state did not change
#   6 upgrade: already at the newest available version. uninstall: already absent.
#     Compliant, not a failure.
#   7 install scope is "user" but no interactively logged-on user was found
#   8 the per-user scheduled task failed to register, run, or report back in time
#   anything else = winget's own exit code (including for verbs other than
#   upgrade/uninstall, which have no version-based verdict of their own).
$ErrorActionPreference = 'Stop'
# 'exit' inside a function ends the whole script, so this is the single exit path.
function Complete-PatchPilotRun {
  param([int]$Code, [string[]]$Message)
  foreach ($line in $Message) { Write-Output "PatchPilot: $line" }
  Write-Output "PatchPilot-Exit: $Code"
  exit $Code
}
$verb = ''
if ($args.Count -gt 0) { $verb = ([string]$args[0]).Trim().ToLowerInvariant() }
if ([string]::IsNullOrWhiteSpace($verb)) {
  Complete-PatchPilotRun -Code 2 -Message 'no winget verb argument supplied.'
}
# Everything after the verb. For upgrade/uninstall this is [packageId, scope?]; for
# any other verb it is relayed to winget untouched, in order.
$rawArgs = @()
if ($args.Count -gt 1) { $rawArgs = @($args[1..($args.Count - 1)]) }

$packageId = $null
$installScopeArg = ''
if ($verb -eq 'upgrade' -or $verb -eq 'uninstall') {
  if ($rawArgs.Count -eq 0 -or [string]::IsNullOrWhiteSpace([string]$rawArgs[0])) {
    Complete-PatchPilotRun -Code 2 -Message "no package id argument supplied for '$verb'."
  }
  $packageId = [string]$rawArgs[0]
  if ($rawArgs.Count -gt 1) { $installScopeArg = ([string]$rawArgs[1]).Trim().ToLowerInvariant() }
}
${USER_CONTEXT_RUNNER}
${USER_CONTEXT_UNINSTALL_RUNNER}
if ($installScopeArg -eq 'user') {
  if ($verb -eq 'upgrade') {
    $result = Invoke-PatchPilotUserContextUpgrade -PackageId $packageId
  } else {
    $result = Invoke-PatchPilotUserContextUninstall -PackageId $packageId
  }
  Complete-PatchPilotRun -Code $result.Code -Message $result.Message
}
${MOCK_SYSTEM_PROFILE}
${WINGET_RESOLVER}
if (-not $winget -or -not (Test-Path $winget)) {
  Complete-PatchPilotRun -Code 3 -Message 'winget.exe not found under WindowsApps.'
}
${RELAX_FOR_NATIVE_CALL}
${WINGET_INSTALLED_VERSION_FN}

if ($verb -eq 'upgrade') {
  # 0x8A15002B APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE - winget's own code for
  # "already on the latest version available", surfaced non-zero from $LASTEXITCODE.
  $wingetUpdateNotApplicable = -1978335189
  $before = Get-PatchPilotInstalledVersion -Winget $winget -PackageId $packageId
  if ($before) {
    Write-Output "PatchPilot: $packageId $before is installed; asking winget to upgrade it."
  } else {
    # Not a stop condition - just an unreadable 'before' reading. Print what winget
    # actually said so the transcript shows the reason instead of a guess at it.
    Write-Output "PatchPilot: 'winget list' reported no installed version for $packageId (exit $script:PatchPilotListingExit). It printed:"
    $script:PatchPilotListing | ForEach-Object { Write-Output ("  " + [string]$_) }
    Write-Output 'PatchPilot: attempting the upgrade anyway.'
  }
  & $winget upgrade --id $packageId ${WINGET_UPGRADE_FLAGS}
  $wingetExit = $LASTEXITCODE
  $after = Get-PatchPilotInstalledVersion -Winget $winget -PackageId $packageId
  Write-Output "PatchPilot: winget exited $wingetExit; installed version is now '$after' (was '$before')."
  if ($after -and $after -ne $before) {
    Complete-PatchPilotRun -Code 0 -Message "$packageId upgraded '$before' -> '$after'."
  }
  if ($wingetExit -eq $wingetUpdateNotApplicable) {
    Complete-PatchPilotRun -Code 6 -Message "$packageId is already at the newest version winget has available ('$after'); no update was applicable."
  }
  if ($wingetExit -ne 0) {
    Complete-PatchPilotRun -Code $wingetExit -Message "winget exited $wingetExit and $packageId was not upgraded."
  }
  # winget exited 0 but the version did not move: report the failure to patch rather
  # than the success of the command.
  Complete-PatchPilotRun -Code 5 -Message @(
    "winget reported no error, but the installed version of $packageId did not change.",
    'The source index on this device offers nothing newer, or the installed entry could not be correlated to the winget package.'
  )
}

if ($verb -eq 'uninstall') {
  $before = Get-PatchPilotInstalledVersion -Winget $winget -PackageId $packageId
  if ($before) {
    Write-Output "PatchPilot: $packageId $before is installed; asking winget to uninstall it."
  } else {
    # Not a stop condition on its own, but there is nothing left to uninstall - report
    # what winget actually said and treat this as the compliant "already gone" verdict.
    Write-Output "PatchPilot: 'winget list' reported no installed version for $packageId (exit $script:PatchPilotListingExit). It printed:"
    $script:PatchPilotListing | ForEach-Object { Write-Output ("  " + [string]$_) }
    Complete-PatchPilotRun -Code 6 -Message "$packageId is not installed; nothing to uninstall."
  }
  & $winget uninstall --id $packageId ${WINGET_UNINSTALL_FLAGS}
  $wingetExit = $LASTEXITCODE
  $after = Get-PatchPilotInstalledVersion -Winget $winget -PackageId $packageId
  Write-Output "PatchPilot: winget exited $wingetExit; installed version is now '$after' (was '$before')."
  if (-not $after) {
    Complete-PatchPilotRun -Code 0 -Message "$packageId (was '$before') was uninstalled."
  }
  if ($wingetExit -ne 0) {
    Complete-PatchPilotRun -Code $wingetExit -Message "winget exited $wingetExit and $packageId was not uninstalled."
  }
  # winget exited 0 but the package is still resolvable. Some uninstallers (Firefox's
  # among them, proven live: job 8a45a270-1217-4815-8ed2-b00b2c2f7bc1 uninstalled
  # 153.0 cleanly and re-read 153.0 immediately after) detach and finish removing
  # their own ARP entry asynchronously after winget's child process has already
  # returned - an immediate re-check can catch the entry before that cleanup lands.
  # One wait-and-recheck tells a real failure apart from that race without adding a
  # retry loop.
  Write-Output "PatchPilot: winget reported success but $packageId still resolves; waiting 5s for uninstall cleanup to finish and rechecking once."
  Start-Sleep -Seconds 5
  $after = Get-PatchPilotInstalledVersion -Winget $winget -PackageId $packageId
  if (-not $after) {
    Complete-PatchPilotRun -Code 0 -Message "$packageId (was '$before') was uninstalled (confirmed on retry)."
  }
  # Still resolvable after the wait: report the failure to remove rather than the
  # success of the command.
  Complete-PatchPilotRun -Code 5 -Message @(
    "winget reported no error, but $packageId is still installed (version '$after') after a 5s retry.",
    'The uninstall may require confirmation winget could not suppress, or the remaining entry could not be correlated to the winget package.'
  )
}

# Any other winget verb (list, search, show, source, ...) is relayed as-is: there is
# no "did it change" question for these, so the verdict is winget's own exit code,
# published through the same sentinel the upgrade/uninstall paths use.
& $winget $verb @rawArgs --disable-interactivity --accept-source-agreements
$wingetExit = $LASTEXITCODE
Complete-PatchPilotRun -Code $wingetExit -Message "winget $verb exited $wingetExit."
`;
}

/**
 * Preview of exactly what a winget upgrade or uninstall does when delivered over
 * Defender Live Response. Live Response cannot execute inline script bodies — it
 * only runs a script already in the tenant's *library*, by name, with string
 * arguments. So the real remediation is NOT the inline `generateWingetRemediation`/
 * `generateWingetUninstall` script; it is the single generic parameterized library
 * script (`wingetLiveResponseLibraryScript`) invoked with a verb, the package id,
 * and — for a per-user-scoped install — a third `"user"` token as its `Args` value.
 * This preview mirrors that invocation so the engineer reviews the true call, not a
 * misleading inline script that never actually runs.
 */
export function wingetLiveResponsePreview(
  packageId: string,
  installScope?: InstallScope | null,
  action?: RemediationAction | null,
): string {
  const userScoped = installScope === "user";
  const uninstall = action === "uninstall";
  const verb = uninstall ? "uninstall" : "upgrade";
  const args = userScoped ? `${verb} ${packageId} user` : `${verb} ${packageId}`;
  return `# PatchPilot - Defender Live Response ${verb} invocation for ${packageId}${
    userScoped ? " (per-user install)" : ""
  }
# Live Response runs a *library* script by name (inline bodies are NOT supported).
# PatchPilot invokes its single auto-provisioned, generic winget script, passing the
# verb${userScoped ? ", the package id, and the install scope" : " and the package id"} as the argument:
#
#   RunScript  ScriptName = PatchPilot-Winget-<content-hash>.ps1
#              Args       = ${args}
${
  userScoped
    ? `#
# This device's software evidence shows a per-user (HKCU) install, which SYSTEM
# cannot see or manage directly — the trailing "user" token routes the library
# script through a short-lived scheduled task running as the interactively
# logged-on user instead (see Invoke-PatchPilotUserContext${uninstall ? "Uninstall" : "Upgrade"} below).
`
    : ""
}#
# The library script is uploaded to the tenant's Live Response library once, on
# first use, and is what actually executes on the device — the same file handles
# every winget verb PatchPilot invokes there, upgrade and uninstall included:
# ---------------------------------------------------------------------------
${wingetLiveResponseLibraryScript()}`;
}

/**
 * Detect script for Intune Remediation — exit 0 = compliant, exit 1 = needs remediation.
 *
 * Reads the installed version out of `winget list` and compares it *as a version*,
 * rather than pattern-matching `minVersion` against the raw output. That older
 * substring match was wrong in both directions: the value is used as a regex, so the
 * dots in `24.08` matched any character (`24x08`, or `124.088` inside another column,
 * counted as compliant); and an installed version *newer* than the minimum contains
 * no literal match at all, so an up-to-date device was reported non-compliant and
 * needlessly remediated.
 */
export function generateWingetDetect(target: WingetTarget): string {
  const minVersion = target.minVersion ?? "0.0.0";
  return `# PatchPilot - Winget detect for ${target.packageId}
# exit 0 = compliant (installed >= ${minVersion}), exit 1 = needs remediation.
$ErrorActionPreference = 'Stop'
$packageId  = '${target.packageId}'
$minVersion = '${minVersion}'
${MOCK_SYSTEM_PROFILE}
${WINGET_RESOLVER}
if (-not $winget -or -not (Test-Path $winget)) {
  # Distinct from "not installed": we cannot see the app, so remediate and let the
  # remediation script report the real reason rather than claiming compliance.
  Write-Output 'PatchPilot: winget.exe not found under WindowsApps.'
  exit 1
}
${RELAX_FOR_NATIVE_CALL}
${WINGET_INSTALLED_VERSION_FN}
$installedVersion = Get-PatchPilotInstalledVersion -Winget $winget -PackageId $packageId
if (-not $installedVersion) {
  Write-Output "PatchPilot: winget does not report $packageId as installed for this account."
  exit 1
}
${VERSION_PARSE_FN}
# Compare as versions so a NEWER install still counts as compliant.
$installedParsed = ConvertTo-PatchPilotVersion -Value $installedVersion
$minParsed       = ConvertTo-PatchPilotVersion -Value $minVersion
if ($null -eq $installedParsed -or $null -eq $minParsed) {
  # No numeric version on one side (winget reports 'Unknown' for plenty of MSI-era
  # installs). Compliance cannot be proven, so say so and remediate: the remediation
  # script reports the real state, whereas a wrong "compliant" hides a vulnerable device.
  Write-Output "PatchPilot: cannot compare installed '$installedVersion' against '$minVersion' as versions."
  exit 1
}
$compliant = $installedParsed -ge $minParsed
if ($compliant) {
  Write-Output "PatchPilot: $packageId $installedVersion satisfies $minVersion."
  exit 0
}
Write-Output "PatchPilot: $packageId $installedVersion is below $minVersion."
exit 1
`;
}

/** Windows Update Agent remediation (OS patches) using the PSWindowsUpdate module. */
export function generateWuaRemediationModule(target: WuaTarget): string {
  return `# PatchPilot - WUA remediation (PSWindowsUpdate) for KB${target.kbId}
$ErrorActionPreference = 'Stop'
Install-Module PSWindowsUpdate -Force -Scope AllUsers
Import-Module PSWindowsUpdate
Get-WindowsUpdate -KBArticleID ${target.kbId} -Install -AcceptAll -IgnoreReboot
`;
}

/**
 * Native WUA COM remediation (OS patches) — preferred for Live Response since
 * it has no module dependency. Reboot handling must go through an Intune
 * Update Ring policy.
 *
 * Exit code is the WUA OperationResultCode (0 NotStarted, 1 InProgress,
 * 2 Succeeded, 3 SucceededWithErrors, 4 Failed, 5 Aborted), forwarded as-is
 * except for 2 which maps to the sentinel's own 0 — only a clean install
 * counts as success. 3 is deliberately NOT folded into 0: an install that
 * "succeeded with errors" is not a verified clean change.
 */
export function generateWuaRemediationCom(target: WuaTarget): string {
  return `# PatchPilot - WUA remediation (native COM) for KB${target.kbId}
# Preferred for Live Response (no module dependency).
# Exit code: WUA OperationResultCode, forwarded as-is except Succeeded (2) -> 0.
$ErrorActionPreference = 'Stop'
# 'exit' inside a function ends the whole script, so this is the single exit path.
function Complete-PatchPilotRun {
  param([int]$Code, [string[]]$Message)
  foreach ($line in $Message) { Write-Output "PatchPilot: $line" }
  Write-Output "PatchPilot-Exit: $Code"
  exit $Code
}
$session  = New-Object -ComObject Microsoft.Update.Session
$searcher = $session.CreateUpdateSearcher()
$results  = $searcher.Search("IsInstalled=0 and Type='Software'")
$toInstall = New-Object -ComObject Microsoft.Update.UpdateColl
foreach ($u in $results.Updates) {
  if ($u.KBArticleIDs -contains '${target.kbId}') { $toInstall.Add($u) | Out-Null }
}
if ($toInstall.Count -eq 0) {
  Complete-PatchPilotRun -Code 0 -Message 'KB${target.kbId} not applicable or already installed.'
}
$downloader = $session.CreateUpdateDownloader(); $downloader.Updates = $toInstall; $downloader.Download() | Out-Null
$installer  = $session.CreateUpdateInstaller();  $installer.Updates  = $toInstall
$result = $installer.Install()
if ($result.ResultCode -eq 2) {
  Complete-PatchPilotRun -Code 0 -Message "KB${target.kbId} installed (HResult $($result.HResult))."
}
Complete-PatchPilotRun -Code $result.ResultCode -Message "KB${target.kbId} install did not succeed cleanly: ResultCode $($result.ResultCode), HResult $($result.HResult)."
`;
}

export interface ChocolateyTarget {
  /** Chocolatey community-repo package id, e.g. "greenshot". */
  packageId: string;
  /** Minimum acceptable version for the detect script, e.g. "24.08". */
  minVersion?: string;
}

/**
 * Chocolatey remediation for an app winget doesn't drive. Bootstraps choco if
 * absent (runs as SYSTEM via Intune Remediation or Live Response), then upgrades.
 * PREVIEW: emitted for review; live dispatch through the public repo is simulated
 * in this build. (Intune Remediation stays preview even after Live Response gets
 * real execution below — see `CHOCO_RESOLVER`'s header comment for why the two
 * channels can't share one script body.)
 */
export function generateChocolateyRemediation(target: ChocolateyTarget): string {
  return `# PatchPilot - Chocolatey remediation for ${target.packageId}
# PREVIEW: Chocolatey delivery is modeled in this build (no live repo call).
# Runs as SYSTEM via Intune Remediation or Live Response.
$ErrorActionPreference = 'Stop'
if (-not (Get-Command choco -ErrorAction SilentlyContinue)) {
  Set-ExecutionPolicy Bypass -Scope Process -Force
  [System.Net.ServicePointManager]::SecurityProtocol = 3072
  Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
}
choco upgrade ${target.packageId} -y --no-progress
exit $LASTEXITCODE
`;
}

/**
 * Bootstraps Chocolatey if absent, then resolves the **absolute path** to
 * `choco.exe` rather than trusting `$env:Path`/`Get-Command` in the same
 * process — same reasoning `WINGET_RESOLVER` documents for resolving a literal
 * path instead of relying on `Get-Command winget`. The official bootstrap
 * (`community.chocolatey.org/install.ps1`) appends to `$env:Path` for the
 * *current* process, but PowerShell's command cache is not guaranteed to pick
 * that up within the same session — resolving the well-known install location
 * directly (`$env:ProgramData\chocolatey\bin\choco.exe`, Chocolatey's own
 * documented default, unaffected by `Path` at all) sidesteps that class of bug
 * entirely rather than hoping the mutation propagated.
 *
 * Before falling back to a fresh bootstrap, also checks the Syncro RMM
 * agent's bundled choco.exe (`...\Kabuto_App_Manager\bin\choco.exe`) — that
 * copy ships as a standard component of the Syncro agent on managed devices,
 * so its presence is expected, not a misconfiguration. A device that already
 * has it does not need (and the community installer isn't guaranteed to play
 * nicely alongside) a second, independently-bootstrapped Chocolatey install;
 * using the Syncro copy directly avoids that conflict entirely. Confirmed
 * live: job 63818b89-6330-4266-92b7-e0f5a9d3a4f7 (FileZilla upgrade) failed
 * on a device where this path already had a working choco.exe.
 */
const CHOCO_RESOLVER = `$choco = Join-Path $env:ProgramData 'chocolatey\\bin\\choco.exe'
if (-not (Test-Path $choco)) {
  $syncroChoco = 'C:\\Program Files\\RepairTech\\Syncro\\Kabuto_App_Manager\\bin\\choco.exe'
  if (Test-Path $syncroChoco) {
    Write-Output "PatchPilot: chocolatey not found at the default location - using the Syncro RMM agent's bundled choco.exe at $syncroChoco instead."
    $choco = $syncroChoco
  }
}
if (-not (Test-Path $choco)) {
  Write-Output 'PatchPilot: chocolatey not found - bootstrapping via community.chocolatey.org/install.ps1...'
  Set-ExecutionPolicy Bypass -Scope Process -Force
  [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
  Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
}
if (-not (Test-Path $choco)) {
  $choco = $null
} else {
  Write-Output "PatchPilot: using $choco"
}`;

/**
 * Reads the version `choco` believes is installed, or `$null` if it can't see
 * the package at all. Mirrors `WINGET_INSTALLED_VERSION_FN`'s contract exactly
 * (including what `$null` does and doesn't mean) so "did this actually change
 * anything?" is answered the same way for both package managers.
 *
 * `choco list --local-only --exact <id> --limit-output` prints
 * `packageId|version` (pipe-delimited, one line per match) rather than
 * winget's padded table, so this needs none of `Get-PatchPilotInstalledVersion`'s
 * column-padding workaround — but the same "diagnostics must not pollute the
 * return value" constraint applies, so listing output is stashed in script
 * scope rather than written from inside the function.
 */
const CHOCO_INSTALLED_VERSION_FN = `function Get-PatchPilotChocoInstalledVersion {
  param([string]$Choco, [string]$PackageId)
  $script:PatchPilotChocoListing = & $Choco list --local-only --exact $PackageId --limit-output 2>&1
  $script:PatchPilotChocoListingExit = $LASTEXITCODE
  foreach ($line in $script:PatchPilotChocoListing) {
    $parts = ([string]$line).Trim().Split('|')
    if ($parts.Count -ge 2 -and $parts[0] -eq $PackageId) { return $parts[1] }
  }
  return $null
}`;

/**
 * Detect script for a Chocolatey-sourced `win32LobApp` — exit 0 = compliant,
 * exit 1 = needs remediation. Sibling of `generateWingetDetect`: same
 * version-comparison contract (compare as `[version]`, never substring-match
 * `minVersion`), same reason a newer-than-minimum install must still count
 * as compliant.
 *
 * Deliberately does NOT bootstrap Chocolatey the way `CHOCO_RESOLVER` does —
 * a detection script Intune may re-run on its own schedule must be
 * side-effect-free, and "choco.exe isn't here" is itself a valid, honest
 * "not installed" verdict for detection purposes (the *install* wrapper is
 * where bootstrapping, gated behind the engineer's own `-InstallChoco`
 * choice, belongs).
 */
export function generateChocolateyDetect(target: ChocolateyTarget): string {
  const minVersion = target.minVersion ?? "0.0.0";
  return `# PatchPilot - Chocolatey detect for ${target.packageId}
# exit 0 = compliant (installed >= ${minVersion}), exit 1 = needs remediation.
# Read-only: does not bootstrap chocolatey - a missing choco.exe just means "not installed".
$ErrorActionPreference = 'Stop'
$packageId  = '${target.packageId}'
$minVersion = '${minVersion}'
$choco = Join-Path $env:ProgramData 'chocolatey\\bin\\choco.exe'
if (-not (Test-Path $choco)) {
  $syncroChoco = 'C:\\Program Files\\RepairTech\\Syncro\\Kabuto_App_Manager\\bin\\choco.exe'
  if (Test-Path $syncroChoco) { $choco = $syncroChoco } else { $choco = $null }
}
if (-not $choco) {
  Write-Output 'PatchPilot: chocolatey not found on this device.'
  exit 1
}
${RELAX_FOR_NATIVE_CALL}
${CHOCO_INSTALLED_VERSION_FN}
$installedVersion = Get-PatchPilotChocoInstalledVersion -Choco $choco -PackageId $packageId
if (-not $installedVersion) {
  Write-Output "PatchPilot: choco does not report $packageId as installed."
  exit 1
}
${VERSION_PARSE_FN}
$installedParsed = ConvertTo-PatchPilotVersion -Value $installedVersion
$minParsed       = ConvertTo-PatchPilotVersion -Value $minVersion
if ($null -eq $installedParsed -or $null -eq $minParsed) {
  Write-Output "PatchPilot: cannot compare installed '$installedVersion' against '$minVersion' as versions."
  exit 1
}
$compliant = $installedParsed -ge $minParsed
if ($compliant) {
  Write-Output "PatchPilot: $packageId $installedVersion satisfies $minVersion."
  exit 0
}
Write-Output "PatchPilot: $packageId $installedVersion is below $minVersion."
exit 1
`;
}

/**
 * The single, parameterized Chocolatey script uploaded ONCE to a tenant's
 * Defender Live Response library and reused for every Chocolatey app
 * PatchPilot ever invokes there — same content-addressed-file architecture as
 * `wingetLiveResponseLibraryScript`, and for the same reason: Live Response
 * only runs *library* scripts by name, never an inline body.
 *
 * Only `upgrade` is supported (uninstall is intentionally out of scope for
 * this pass — see PatchPilot's Chocolatey plan). `choco upgrade` already
 * installs the package when it isn't present, so one verb covers both "not
 * installed yet" and "installed but outdated" — there is no separate
 * `install` path to keep in sync with this one.
 *
 * Unlike the winget library script, there is no per-user scheduled-task
 * routing here: Chocolatey always installs machine-wide (it has no per-user
 * install scope in the way an MSIX-packaged winget app can), so the
 * SYSTEM-context call is the only path this script ever needs.
 *
 * Same verdict philosophy as the winget script, and the same reason: never
 * trust `choco`'s own exit code for "did this actually change/succeed" —
 * diff the installed version before and after instead. And the same
 * `PatchPilot-Exit: <n>` sentinel convention, parsed by the same
 * worker-side `parseVerdict` — Defender's own `exit_code` does not carry a
 * Live Response script's real exit code (proven live on the winget path; see
 * that script's JSDoc for the transcript that proved it).
 */
export function chocolateyLiveResponseLibraryScript(): string {
  return `# PatchPilot - Chocolatey Live Response library script (parameterized, generic)
# Runs as SYSTEM via Defender Live Response. Bootstraps choco.exe if absent, then runs
# the verb passed as Live Response Args:
#   upgrade <packageId>   the only verb supported today - installs the package if
#                          absent, or upgrades it if already present ('choco upgrade'
#                          does both, so there is no separate install verb).
# e.g. RunScript with Args "upgrade filezilla".
#
# The verdict is published as a 'PatchPilot-Exit: <n>' line on stdout, because
# Defender's own exit_code does NOT carry this script's exit code (same caveat as
# the winget library script - see wingetLiveResponseLibraryScript's JSDoc).
#   0 the installed version actually changed (installed, or upgraded to a new one)
#   2 no verb, or no package id supplied for upgrade   3 choco.exe not found and the
#     bootstrap install did not produce it
#   5 choco ran cleanly but the installed version did not change
#   6 already at the newest version choco has available. Compliant, not a failure.
#   anything else = choco's own exit code.
$ErrorActionPreference = 'Stop'
function Complete-PatchPilotRun {
  param([int]$Code, [string[]]$Message)
  foreach ($line in $Message) { Write-Output "PatchPilot: $line" }
  Write-Output "PatchPilot-Exit: $Code"
  exit $Code
}
$verb = ''
if ($args.Count -gt 0) { $verb = ([string]$args[0]).Trim().ToLowerInvariant() }
if ($verb -ne 'upgrade') {
  Complete-PatchPilotRun -Code 2 -Message "unsupported or missing verb '$verb' - only 'upgrade' is supported today."
}
if ($args.Count -lt 2 -or [string]::IsNullOrWhiteSpace([string]$args[1])) {
  Complete-PatchPilotRun -Code 2 -Message 'no package id argument supplied for upgrade.'
}
$packageId = [string]$args[1]

${RELAX_FOR_NATIVE_CALL}
${CHOCO_RESOLVER}
if (-not $choco -or -not (Test-Path $choco)) {
  Complete-PatchPilotRun -Code 3 -Message 'choco.exe not found and the bootstrap install did not produce it.'
}
${CHOCO_INSTALLED_VERSION_FN}

$before = Get-PatchPilotChocoInstalledVersion -Choco $choco -PackageId $packageId
if ($before) {
  Write-Output "PatchPilot: $packageId $before is installed; asking choco to upgrade it."
} else {
  Write-Output "PatchPilot: choco does not report $packageId as installed (exit $script:PatchPilotChocoListingExit); asking choco to install it."
}
& $choco upgrade $packageId -y --no-progress
$chocoExit = $LASTEXITCODE
$after = Get-PatchPilotChocoInstalledVersion -Choco $choco -PackageId $packageId
Write-Output "PatchPilot: choco exited $chocoExit; installed version is now '$after' (was '$before')."
if ($after -and $after -ne $before) {
  Complete-PatchPilotRun -Code 0 -Message "$packageId installed/upgraded '$before' -> '$after'."
}
if ($chocoExit -eq 0 -and $before -and $after -eq $before) {
  Complete-PatchPilotRun -Code 6 -Message "$packageId is already at the newest version choco has available ('$after')."
}
if ($chocoExit -ne 0) {
  Complete-PatchPilotRun -Code $chocoExit -Message "choco exited $chocoExit and $packageId was not installed/upgraded."
}
Complete-PatchPilotRun -Code 5 -Message @(
  "choco reported no error, but the installed version of $packageId did not change.",
  'The source index on this device offers nothing newer, or the installed entry could not be correlated to the choco package.'
)
`;
}

/**
 * Preview of exactly what a Chocolatey upgrade does when delivered over
 * Defender Live Response — the Chocolatey counterpart to
 * `wingetLiveResponsePreview`, for the same reason: Live Response cannot run
 * an inline script body, only an already-provisioned *library* script by
 * name, so the real remediation is the single generic
 * `chocolateyLiveResponseLibraryScript`, not the inline PREVIEW-only
 * `generateChocolateyRemediation`.
 */
export function chocolateyLiveResponsePreview(packageId: string): string {
  const args = `upgrade ${packageId}`;
  return `# PatchPilot - Defender Live Response chocolatey invocation for ${packageId}
# Live Response runs a *library* script by name (inline bodies are NOT supported).
# PatchPilot invokes its single auto-provisioned, generic Chocolatey script, passing
# the verb and the package id as the argument:
#
#   RunScript  ScriptName = PatchPilot-Chocolatey-<content-hash>.ps1
#              Args       = ${args}
#
# The library script is uploaded to the tenant's Live Response library once, on
# first use, and is what actually executes on the device:
# ---------------------------------------------------------------------------
${chocolateyLiveResponseLibraryScript()}`;
}

export interface StoreAppTarget {
  /** Microsoft Store product id, e.g. "9NKSQGP7F2NH". */
  productId: string;
  /** Software label for the comment header. */
  software: string;
}

/**
 * Microsoft Store remediation — installs/updates a Store-published app through
 * winget's `msstore` source (silent, as SYSTEM). PREVIEW: emitted for review;
 * live Store deployment is simulated in this build.
 */
export function generateStoreAppRemediation(target: StoreAppTarget): string {
  return `# PatchPilot - Microsoft Store remediation for ${target.software} (${target.productId})
# PREVIEW: Store delivery is modeled in this build (no live Store call).
$ErrorActionPreference = 'Stop'
${MOCK_SYSTEM_PROFILE}
${WINGET_RESOLVER}
${RELAX_FOR_NATIVE_CALL}
& $winget install --id ${target.productId} --source msstore --silent \`
  --accept-source-agreements --accept-package-agreements
exit $LASTEXITCODE
`;
}

export interface WinGetAppDeployPreviewInput {
  /** Microsoft Store package id resolved via a live manifestSearch pick. */
  packageId: string;
  software: string;
  displayName?: string | null;
  publisher?: string | null;
  runAsAccount?: "system" | "user" | null;
}

/**
 * Preview for the winget-app channel ("Microsoft Store app (new)"). Not a
 * script: this channel never runs anything on the device at all — it
 * creates-or-reuses a Graph `winGetApp` object for the selected Store
 * package, assigns it, and calls `syncDevice`. Shown in place of a generated
 * PowerShell body so the engineer reviews the actual Graph sequence about to
 * run instead of an irrelevant winget script left over from another channel.
 */
export function winGetAppDeployPreview(input: WinGetAppDeployPreviewInput): string {
  const name = input.displayName?.trim() || input.software;
  const publisherSuffix = input.publisher?.trim() ? ` by ${input.publisher.trim()}` : "";
  const runAs = input.runAsAccount ?? "system";
  return `# PatchPilot - Microsoft Store app (new) deploy for ${input.software}
# This channel runs no script on the device. Instead:
#   1. Create-or-reuse an Intune winGetApp object for Microsoft Store package
#      ${input.packageId} ("${name}"${publisherSuffix}).
#   2. Assign it to the configured target, installed as ${runAs}.
#   3. Call syncDevice so Intune Management Extension picks up the assignment.
`;
}

export interface FeatureUpdateDeployPreviewInput {
  hostname: string;
  /** Friendly target label, e.g. "24H2". */
  versionLabel: string;
}

/**
 * Preview for the expedited-feature-update channel. Not a script: like
 * winget-app above, this channel runs nothing on the device — it creates a
 * fresh `windowsFeatureUpdateProfile` and assigns it to this one device via a
 * hostname-scoped assignment filter. Shown in place of a generated
 * PowerShell body so the engineer reviews the actual Graph sequence rather
 * than an irrelevant WUA COM script meant for a KB-based quality update.
 */
export function featureUpdateDeployPreview(input: FeatureUpdateDeployPreviewInput): string {
  return `# PatchPilot - Expedited Feature Update for ${input.hostname}
# This channel runs no script on the device. Instead:
#   1. Create a windowsFeatureUpdateProfile targeting ${input.versionLabel}.
#   2. Assign it to ${input.hostname} via a hostname-scoped assignment filter.
# The device installs the feature update on its own schedule once it checks
# in with Intune — this may take hours, not seconds.
`;
}

/** Upgrade (default) or remove the resolved winget package. */
export type RemediationAction = "upgrade" | "uninstall";

/** Everything the script generator needs to pick the right remediation body. */
export interface RemediationScriptInput {
  channel: RemediationChannel;
  /** Winget package id for app findings; null for OS findings. */
  wingetPackageId: string | null;
  /** KB article id (no "KB" prefix) for OS findings, when known. */
  kbId?: string | null;
  /** Software/finding label, for the comment header when nothing maps. */
  software: string;
  /**
   * Alternate repo to drive a not-supported app through, when winget has no
   * package. When set, `altPackageId` is the source-native id to install.
   */
  source?: PackageSource | null;
  /** Source-native package id (Chocolatey id / Store product id) for `source`. */
  altPackageId?: string | null;
  /** Install scope evidence for the app finding — only affects the live-response preview's Args. */
  installScope?: InstallScope | null;
  /**
   * "uninstall" swaps the winget upgrade generators for their uninstall
   * counterparts. Winget-only: an alternate `source` (Chocolatey/Store) or an
   * OS finding with no `wingetPackageId` ignores this and behaves as before —
   * there is no uninstall path for those yet. Defaults to "upgrade".
   */
  action?: RemediationAction | null;
}

/**
 * Picks the deployable script for a remediation. An explicit alternate `source`
 * (a not-supported app routed to Chocolatey or the Microsoft Store) wins first;
 * otherwise app findings with a mapped winget package get the winget upgrade (or,
 * with `action: "uninstall"`, the winget uninstall) and OS findings get the native
 * WUA COM script, which works in both Live Response and Intune Remediation without
 * a module dependency. The chosen channel only affects *how* this is delivered,
 * not the payload, so the body is channel-agnostic.
 */
export function remediationScript(input: RemediationScriptInput): string {
  if (input.source && input.altPackageId) {
    if (input.source === "chocolatey") {
      // Live Response delivers Chocolatey as a parameterized library-script
      // call too, not the inline PREVIEW-only script — same reasoning as the
      // winget live-response branch just below.
      if (input.channel === "live-response") {
        return chocolateyLiveResponsePreview(input.altPackageId);
      }
      return generateChocolateyRemediation({ packageId: input.altPackageId });
    }
    if (input.source === "microsoft-store") {
      return generateStoreAppRemediation({
        productId: input.altPackageId,
        software: input.software,
      });
    }
  }
  if (input.wingetPackageId) {
    // Live Response delivers winget as a parameterized library-script call, not
    // an inline upgrade/uninstall — preview the real invocation so the preview
    // matches what the executor actually runs on the device.
    if (input.channel === "live-response") {
      return wingetLiveResponsePreview(input.wingetPackageId, input.installScope, input.action);
    }
    if (input.action === "uninstall") {
      return generateWingetUninstall({ packageId: input.wingetPackageId });
    }
    return generateWingetRemediation({ packageId: input.wingetPackageId });
  }
  return generateWuaRemediationCom({ kbId: input.kbId ?? "0000000" });
}

/**
 * Win32 app content wrapper scripts (Phase 2 — `.intunewin`-packaged apps).
 *
 * Deliberately distinct from `generateWingetRemediation`/
 * `generateChocolateyRemediation` above, which bake the package id directly
 * into the script body — fine for Live Response, where a fresh script is
 * generated per package anyway. These generators take NO per-package
 * arguments and return fixed, content-stable text: the whole point is that
 * the `.intunewin` **content** these scripts become is byte-identical across
 * every package in a catalog family, so it is built and encrypted (via
 * `buildIntuneWinPackage`) exactly once per family and reused forever. Only
 * the Intune `installCommandLine`/`uninstallCommandLine` strings differ per
 * app — plain text on the app object, free to vary — e.g.
 * `powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1 -PackageId 7zip.7zip`.
 *
 * Exit code is the underlying package manager's own `$LASTEXITCODE`, relayed
 * unmodified — Intune's `win32LobApp.returnCodes` is what maps that number to
 * success/soft-reboot/hard-reboot/failure, not this script. Detection (is the
 * app already present, so Intune should skip installCommandLine entirely) is
 * a completely separate, per-app plain-text property on the `win32LobApp`
 * object (`generateWingetDetect`/`generateChocolateyDetect`), never part of
 * this encrypted content.
 */

/** Winget install wrapper — generic across every package; `-PackageId` is supplied at install time by Intune. */
export function generateWin32WingetWrapperInstall(): string {
  return `# PatchPilot - Win32 app winget install wrapper (generic, parameterized)
# Invoked by Intune's installCommandLine, e.g.:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1 -PackageId <id> [-CustomArguments "..."]
# Exit code is winget's own ($LASTEXITCODE) - Intune's win32LobApp.returnCodes maps it to
# success/reboot-required/failure. Detection is a SEPARATE per-app property, not this script.
param(
  [Parameter(Mandatory = $true)]
  [string]$PackageId,
  [string]$CustomArguments = ''
)
$ErrorActionPreference = 'Stop'
${MOCK_SYSTEM_PROFILE}
${WINGET_RESOLVER}
if (-not $winget -or -not (Test-Path $winget)) {
  Write-Output 'PatchPilot: winget.exe not found under WindowsApps.'
  exit 3
}
${RELAX_FOR_NATIVE_CALL}
$extra = @()
if ($CustomArguments) { $extra = $CustomArguments -split '\\s+' | Where-Object { $_ } }
& $winget install --id $PackageId ${WINGET_INSTALL_FLAGS} @extra
exit $LASTEXITCODE
`;
}

/** Winget uninstall wrapper — the removal counterpart, invoked by Intune's uninstallCommandLine. */
export function generateWin32WingetWrapperUninstall(): string {
  return `# PatchPilot - Win32 app winget uninstall wrapper (generic, parameterized)
# Invoked by Intune's uninstallCommandLine, e.g.:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1 -PackageId <id> [-CustomArguments "..."]
param(
  [Parameter(Mandatory = $true)]
  [string]$PackageId,
  [string]$CustomArguments = ''
)
$ErrorActionPreference = 'Stop'
${MOCK_SYSTEM_PROFILE}
${WINGET_RESOLVER}
if (-not $winget -or -not (Test-Path $winget)) {
  Write-Output 'PatchPilot: winget.exe not found under WindowsApps.'
  exit 3
}
${RELAX_FOR_NATIVE_CALL}
$extra = @()
if ($CustomArguments) { $extra = $CustomArguments -split '\\s+' | Where-Object { $_ } }
& $winget uninstall --id $PackageId ${WINGET_UNINSTALL_FLAGS} @extra
exit $LASTEXITCODE
`;
}

/**
 * Chocolatey install wrapper — generic across every package; `-Packagename`
 * is supplied at install time by Intune. `-InstallChoco` gates whether a
 * missing `choco.exe` gets bootstrapped (reusing `CHOCO_RESOLVER`'s own
 * bootstrap logic) or treated as a hard failure — deliberately NOT always-on
 * like `CHOCO_RESOLVER`'s callers elsewhere in this file, since silently
 * installing a whole package manager as a side effect of every app deploy is
 * a bigger blast radius than an engineer may have intended; the Deploy App
 * form surfaces this as an explicit toggle. `-CustomRepo` targets an
 * alternate Chocolatey source (private/internal feed) instead of the public
 * community repo.
 */
export function generateWin32ChocolateyWrapperInstall(): string {
  return `# PatchPilot - Win32 app Chocolatey install wrapper (generic, parameterized)
# Invoked by Intune's installCommandLine, e.g.:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Packagename <id> [-InstallChoco] [-CustomRepo "https://..."] [-CustomArguments "..."]
# Exit code is choco's own ($LASTEXITCODE) - Intune's win32LobApp.returnCodes maps it to
# success/reboot-required/failure. Detection is a SEPARATE per-app property, not this script.
param(
  [Parameter(Mandatory = $true)]
  [string]$Packagename,
  [switch]$InstallChoco,
  [string]$CustomRepo = '',
  [string]$CustomArguments = ''
)
$ErrorActionPreference = 'Stop'
if ($InstallChoco) {
${CHOCO_RESOLVER}
} else {
  $choco = Join-Path $env:ProgramData 'chocolatey\\bin\\choco.exe'
  if (-not (Test-Path $choco)) {
    $syncroChoco = 'C:\\Program Files\\RepairTech\\Syncro\\Kabuto_App_Manager\\bin\\choco.exe'
    if (Test-Path $syncroChoco) { $choco = $syncroChoco } else { $choco = $null }
  }
}
if (-not $choco -or -not (Test-Path $choco)) {
  Write-Output 'PatchPilot: choco.exe not found and -InstallChoco was not specified.'
  exit 3
}
${RELAX_FOR_NATIVE_CALL}
$extra = @()
if ($CustomArguments) { $extra = $CustomArguments -split '\\s+' | Where-Object { $_ } }
$sourceArgs = @()
if ($CustomRepo) { $sourceArgs = @('--source', $CustomRepo) }
& $choco install $Packagename -y --no-progress @sourceArgs @extra
exit $LASTEXITCODE
`;
}

/** Chocolatey uninstall wrapper — the removal counterpart, invoked by Intune's uninstallCommandLine. */
export function generateWin32ChocolateyWrapperUninstall(): string {
  return `# PatchPilot - Win32 app Chocolatey uninstall wrapper (generic, parameterized)
# Invoked by Intune's uninstallCommandLine, e.g.:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1 -Packagename <id> [-CustomArguments "..."]
param(
  [Parameter(Mandatory = $true)]
  [string]$Packagename,
  [string]$CustomArguments = ''
)
$ErrorActionPreference = 'Stop'
$choco = Join-Path $env:ProgramData 'chocolatey\\bin\\choco.exe'
if (-not (Test-Path $choco)) {
  $syncroChoco = 'C:\\Program Files\\RepairTech\\Syncro\\Kabuto_App_Manager\\bin\\choco.exe'
  if (Test-Path $syncroChoco) { $choco = $syncroChoco } else { $choco = $null }
}
if (-not $choco -or -not (Test-Path $choco)) {
  Write-Output 'PatchPilot: choco.exe not found - nothing to uninstall from.'
  exit 3
}
${RELAX_FOR_NATIVE_CALL}
$extra = @()
if ($CustomArguments) { $extra = $CustomArguments -split '\\s+' | Where-Object { $_ } }
& $choco uninstall $Packagename -y --no-progress @extra
exit $LASTEXITCODE
`;
}

/**
 * Registry key Win32-deployed Script Catalog entries mark themselves under
 * after a successful (exit 0) run — `generateScriptDetect` reads it back.
 * There's no package-manager-reported "is this installed" signal for an
 * arbitrary script the way winget/Chocolatey have one, so this is
 * PatchPilot's own install-detection convention: the *value name* is the
 * script catalog entry's id, and the *value data* is a sha256 hash of the
 * script content that was actually run. An edited script gets a new hash, so
 * a stale marker no longer matches and detection correctly reports
 * "needs remediation" — the same content-addressed idea Docker/git use for
 * "did this change", applied to one registry value.
 */
export const WIN32_SCRIPT_MARKER_KEY = "HKLM:\\SOFTWARE\\PatchPilot\\Win32Scripts";

export interface Win32ScriptWrapperInput {
  scriptCatalogEntryId: string;
  scriptContent: string;
  contentHash: string;
}

/**
 * Script Catalog install wrapper — unlike the winget/Chocolatey wrappers
 * (generic across every package, parameterized at install time), this one
 * embeds one specific catalog entry's content directly: a raw script has no
 * package-manager id Intune's installCommandLine could pass in, so the
 * content itself has to be the packaged artifact. That also means, unlike
 * the other two families, this wrapper package is NOT shared across entries —
 * see `getWin32ScriptWrapperPackage`'s per-entry cache.
 */
export function generateWin32ScriptWrapperInstall(input: Win32ScriptWrapperInput): string {
  return `# PatchPilot - Win32 app Script Catalog install wrapper for "${input.scriptCatalogEntryId}"
# Runs the catalog script embedded below. On success (no terminating error),
# writes a registry marker so a future detection run can confirm this exact
# script content is installed without re-running it.
$ErrorActionPreference = 'Stop'
$ScriptCatalogEntryId = '${input.scriptCatalogEntryId}'
$ContentHash = '${input.contentHash}'

try {
${input.scriptContent}
} catch {
  Write-Output "PatchPilot: script threw: $($_.Exception.Message)"
  exit 1
}

if (-not (Test-Path '${WIN32_SCRIPT_MARKER_KEY}')) {
  New-Item -Path '${WIN32_SCRIPT_MARKER_KEY}' -Force | Out-Null
}
New-ItemProperty -Path '${WIN32_SCRIPT_MARKER_KEY}' -Name $ScriptCatalogEntryId -Value $ContentHash -PropertyType String -Force | Out-Null
exit 0
`;
}

/**
 * Script Catalog uninstall wrapper. A catalogued script has no defined
 * "undo" action of its own — this only removes PatchPilot's own install
 * marker, which is enough to make detection fail and force a reinstall on
 * the next dispatch, mirroring what "uninstall" means for the other two
 * families in practice (Intune re-runs installCommandLine when detection
 * next fails, it never truly reverses a package).
 */
export function generateWin32ScriptWrapperUninstall(
  input: Pick<Win32ScriptWrapperInput, "scriptCatalogEntryId">,
): string {
  return `# PatchPilot - Win32 app Script Catalog uninstall wrapper for "${input.scriptCatalogEntryId}"
# No catalogued "undo" exists for an arbitrary script - this only clears
# PatchPilot's own install marker so detection reports "needs remediation".
$ErrorActionPreference = 'Stop'
$ScriptCatalogEntryId = '${input.scriptCatalogEntryId}'
if (Test-Path '${WIN32_SCRIPT_MARKER_KEY}') {
  Remove-ItemProperty -Path '${WIN32_SCRIPT_MARKER_KEY}' -Name $ScriptCatalogEntryId -ErrorAction SilentlyContinue
}
exit 0
`;
}

/**
 * Detect script for a Win32-deployed Script Catalog entry — exit 0 = the
 * marker `generateWin32ScriptWrapperInstall` writes is present and matches
 * the *current* content hash, exit 1 = missing or stale (script was edited
 * since the last successful install), same contract as
 * `generateWingetDetect`/`generateChocolateyDetect`.
 */
export function generateScriptDetect(
  input: Pick<Win32ScriptWrapperInput, "scriptCatalogEntryId" | "contentHash">,
): string {
  return `# PatchPilot - Win32 Script Catalog detect for "${input.scriptCatalogEntryId}"
# exit 0 = compliant (marker matches current content hash), exit 1 = needs remediation.
$ErrorActionPreference = 'Stop'
$ScriptCatalogEntryId = '${input.scriptCatalogEntryId}'
$ExpectedHash = '${input.contentHash}'
if (-not (Test-Path '${WIN32_SCRIPT_MARKER_KEY}')) {
  Write-Output 'PatchPilot: no Win32Scripts marker key present.'
  exit 1
}
$actual = (Get-ItemProperty -Path '${WIN32_SCRIPT_MARKER_KEY}' -Name $ScriptCatalogEntryId -ErrorAction SilentlyContinue).$ScriptCatalogEntryId
if (-not $actual) {
  Write-Output "PatchPilot: no marker recorded for $ScriptCatalogEntryId."
  exit 1
}
if ($actual -eq $ExpectedHash) {
  Write-Output "PatchPilot: marker matches current content hash."
  exit 0
}
Write-Output "PatchPilot: marker $actual does not match expected $ExpectedHash - script content changed."
exit 1
`;
}

/**
 * Win32 app wrapper family a package deploys through — winget's own resolver,
 * Chocolatey's, or a raw PowerShell Script Catalog entry run directly. Shared
 * between the Deploy App API route and the worker executor's win32-app
 * channel so both build byte-identical command lines for the same (source,
 * packageId, options) input — the executor has to be able to reproduce
 * exactly what the deploy call would have created.
 */
export type Win32Source = "winget" | "chocolatey" | "script";
export function isWin32Source(v: unknown): v is Win32Source {
  return v === "winget" || v === "chocolatey" || v === "script";
}

/**
 * Quotes a value for safe interpolation into a PowerShell double-quoted
 * argument on an Intune `installCommandLine`/`uninstallCommandLine` string —
 * these come from catalog/user-supplied text (packageId, custom args), so
 * they're never trusted to be shell-safe as-is.
 */
export function psQuoteArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Builds the plain-text installCommandLine/uninstallCommandLine for a
 * win32LobApp from a catalog package. Script-sourced entries take neither
 * `packageId` nor any of the winget/Chocolatey-only options as a CLI
 * argument — the script content is baked into the packaged wrapper itself
 * (see `getWin32ScriptWrapperPackage`), so the command line is fixed.
 */
export function buildWin32CommandLines(input: {
  source: Win32Source;
  packageId: string;
  installChoco: boolean;
  customRepo?: string;
  customArguments?: string;
}): { installCommandLine: string; uninstallCommandLine: string } {
  const { source, packageId, installChoco, customRepo, customArguments } = input;
  const customArgsFlag = customArguments ? ` -CustomArguments ${psQuoteArg(customArguments)}` : "";

  if (source === "winget") {
    return {
      installCommandLine: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1 -PackageId ${psQuoteArg(packageId)}${customArgsFlag}`,
      uninstallCommandLine: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1 -PackageId ${psQuoteArg(packageId)}${customArgsFlag}`,
    };
  }

  if (source === "script") {
    return {
      installCommandLine: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1`,
      uninstallCommandLine: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1`,
    };
  }

  const installChocoFlag = installChoco ? " -InstallChoco" : "";
  const customRepoFlag = customRepo ? ` -CustomRepo ${psQuoteArg(customRepo)}` : "";
  return {
    installCommandLine: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Packagename ${psQuoteArg(packageId)}${installChocoFlag}${customRepoFlag}${customArgsFlag}`,
    uninstallCommandLine: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1 -Packagename ${psQuoteArg(packageId)}${customArgsFlag}`,
  };
}
