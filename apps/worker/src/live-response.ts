import { randomUUID } from "node:crypto";
import {
  graphGet,
  graphWrite,
  graphUpload,
  sha256Hex,
  GraphError,
} from "@patchpilot/graph";
import {
  wingetLiveResponseLibraryScript,
  chocolateyLiveResponseLibraryScript,
  generateWuaRemediationCom,
  sanitizeDbTextBounded,
  type InstallScope,
  type RemediationAction,
} from "@patchpilot/shared";
import { connection } from "./queue.js";
import { logger } from "./logger.js";

const modLog = logger.child({ module: "live-response" });

/**
 * Defender Live Response remediation — the fully-automated channel.
 *
 * Defender can only run scripts that already live in a tenant's Live Response
 * *library* (inline script bodies are not supported by the API), so a naive
 * implementation would require an engineer to manually upload a script per tenant
 * in the Defender portal. Instead PatchPilot provisions the script itself: it keeps
 * ONE generic, parameterized winget script (`wingetLiveResponseLibraryScript`) whose
 * file name is a hash of its own content, uploads it to the tenant's library on
 * first use, and thereafter invokes it by name with a verb (upgrade/uninstall/any
 * other winget subcommand) plus that verb's arguments as its Args string.
 * Onboarding a tenant therefore needs no Defender-portal step.
 *
 * The full flow, all through the audited graph client:
 *   1. ensure the library script exists  (GET /libraryfiles, POST if missing)
 *   2. invoke it                          (POST /machines/{id}/runliveresponse)
 *   3. poll to a terminal state           (GET  /machineactions/{id})
 *   4. fetch + parse the script result    (GET  .../GetLiveResponseResultDownloadLink)
 *
 * The one prerequisite PatchPilot can't automate is a tenant toggle: Live Response
 * (and unsigned-script execution) must be enabled in Defender's Advanced Features.
 * Absent that, step 2 fails with a Defender error, which we surface honestly.
 */

export interface LiveResponseInput {
  engineer: string;
  homeTenantId: string;
  tenantId: string;
  /** Defender machine id of the target device. */
  machineId: string;
  /** Winget package id passed to the library script, e.g. "7zip.7zip". */
  packageId: string;
  /**
   * Install-scope evidence for this app. "user" adds a trailing Args token that
   * routes the library script through the scheduled-task-as-logged-in-user
   * path instead of the direct-SYSTEM winget call — see
   * wingetLiveResponseLibraryScript's JSDoc. Anything else runs the unchanged
   * direct-SYSTEM path.
   */
  installScope?: InstallScope | null;
  /**
   * Selects the verb passed to the single generic library script — "upgrade"
   * (default/absent) or "uninstall". Both share the same content-addressed
   * file; only the Args string differs.
   */
  action?: RemediationAction | null;
  /**
   * Called with the full progress transcript so far, each time a new line is
   * appended. Lets the caller (worker executor) persist it onto the job's
   * `output` column live, so the Jobs UI shows what's happening on the device
   * instead of an opaque "Running" until the action reaches a terminal state.
   */
  onProgress?: (transcript: string) => void | Promise<void>;
}

export interface LiveResponseResult {
  exitCode: number;
  output: string;
}

/** Poll cadence and ceiling for a machine action. Live Response is "seconds" once the
 *  device has checked in, but the unattended Machine Actions API (unlike the portal's
 *  interactive console, which pushes a live session on click) only picks up a pending
 *  action on the device's own regular check-in cycle — Microsoft's documented default
 *  is ~5 min, so a 4 min ceiling was cancelling healthy-but-not-yet-checked-in devices
 *  before they got a chance. Cap at ~5 min then hand back. */
const POLL_INTERVAL_MS = 6_000;
const POLL_TIMEOUT_MS = 5 * 60_000;

/** Bounds the raw SAS-blob fetch below (Azure Blob Storage, not the Graph client, so
 *  it doesn't get graphGet's built-in timeout) — an unbounded fetch here would hang
 *  the whole job up to the outer JOB_TIMEOUT_MS backstop with no diagnostic in between. */
const RESULT_FETCH_TIMEOUT_MS = 30_000;

const TERMINAL_STATUSES = new Set(["Succeeded", "Failed", "Cancelled", "TimeOut"]);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Content-addressed library file name: same script body -> same name (under a
 *  given prefix), so the "already uploaded?" check is a cheap exact-name match
 *  with no override churn. One generic script now covers every verb a given
 *  package manager supports (upgrade/uninstall/other for winget; upgrade for
 *  Chocolatey), so there is a single name prefix per manager rather than one
 *  per verb. */
function libraryFileName(prefix: string, script: string): string {
  return `PatchPilot-${prefix}-${sha256Hex(script).slice(0, 8)}.ps1`;
}

interface LibraryFile {
  fileName: string;
}

/** Appends timestamped lines to an in-memory transcript and hands the full text
 *  to the caller's onProgress after every line, so a hung/slow stage is visible
 *  in the Jobs UI instead of looking identical to a crashed worker. */
class ProgressLog {
  private lines: string[] = [];
  constructor(private readonly onProgress?: (transcript: string) => void | Promise<void>) {}

  get text(): string {
    return this.lines.join("\n");
  }

  async log(line: string): Promise<void> {
    const stamp = new Date().toISOString().slice(11, 19); // HH:MM:SS, enough for a single run
    this.lines.push(`[${stamp}] ${line}`);
    try {
      await this.onProgress?.(this.text);
    } catch (err) {
      // A progress-persist failure (e.g. a transient DB hiccup) must never abort
      // the remediation itself — only the live view degrades.
      modLog.error({ err }, "onProgress callback failed");
    }
  }
}

interface EnsureLibraryScriptOptions {
  /** The script body itself — determines the content-addressed file name. */
  script: string;
  /** Name prefix, e.g. "Winget", "Chocolatey", "WUA" — see libraryFileName. */
  prefix: string;
  /** Uploaded as the library file's Description field. */
  description: string;
  /** Uploaded as ParametersDescription; presence also sets HasParameters. */
  parametersDescription?: string;
}

/**
 * Ensure a generic parameterized remediation script is present in the tenant's
 * Live Response library, uploading it if absent. Returns the file name to
 * invoke. Idempotent: an unchanged script maps to a stable name, so repeat
 * calls just confirm presence. Shared by every Live Response dispatch path
 * (winget, Chocolatey, per-KB WUA) — only the script body, name prefix, and
 * upload description differ between them.
 */
async function ensureLibraryScript(
  input: { engineer: string; homeTenantId: string; tenantId: string },
  opts: EnsureLibraryScriptOptions,
  progress: ProgressLog,
): Promise<string> {
  const { script, prefix, description, parametersDescription } = opts;
  const fileName = libraryFileName(prefix, script);

  await progress.log(`Checking Live Response library for ${fileName}...`);
  const listed = await graphGet<{ value?: LibraryFile[] }>({
    engineer: input.engineer,
    homeTenantId: input.homeTenantId,
    tenantId: input.tenantId,
    host: "defender",
    path: "/libraryfiles",
  });
  if (!listed.ok) {
    throw new GraphError(listed.status, `could not list Live Response library files (HTTP ${listed.status})`);
  }
  const present = (listed.data?.value ?? []).some((f) => f.fileName === fileName);
  if (present) {
    await progress.log("Library script already present.");
    return fileName;
  }

  await progress.log("Library script not found — uploading it now...");
  const uploaded = await graphUpload({
    engineer: input.engineer,
    homeTenantId: input.homeTenantId,
    tenantId: input.tenantId,
    host: "defender",
    path: "/libraryfiles",
    file: { fileName, content: script, contentType: "text/plain" },
    fields: {
      Description: description,
      HasParameters: parametersDescription ? "true" : "false",
      ...(parametersDescription ? { ParametersDescription: parametersDescription } : {}),
      OverrideIfExists: "false",
    },
  });
  if (!uploaded.ok) {
    throw new GraphError(uploaded.status, `library script upload failed (HTTP ${uploaded.status})`);
  }
  await progress.log("Library script uploaded.");
  return fileName;
}

interface MachineAction {
  id: string;
  status: string;
}

interface ScriptResult {
  script_name?: string;
  exit_code?: number;
  script_output?: string;
  script_errors?: string;
}

/**
 * Defender allows only one active Live Response session per device — a second
 * concurrent request against the same machine is rejected outright (HTTP 400
 * "ActiveRequestAlreadyExists"). Fix All creates one job per software group and
 * enqueues them together, so several jobs for the same device can land at the
 * same moment. Without serializing here, the losing jobs don't just fail
 * cleanly — they can end up polling/reading back whichever action the device
 * actually ran.
 *
 * The lock lives in Redis, not process memory. It used to be an in-process
 * Map/Set, which only serializes calls made by ONE worker process — confirmed
 * live that two worker processes (a leftover duplicate from a crash-restart
 * supervisor cycling mid-session) were both consuming the same BullMQ queue,
 * each with its own in-memory lock that knew nothing about the other's
 * in-flight job for the same device: Defender rejected the second request
 * outright (HTTP 400), and the resulting contention produced a follow-on
 * HTTP 502. An in-memory lock is only ever as good as "exactly one worker
 * process exists," which nothing here enforces — a crash-restart supervisor,
 * an operator running two instances, or future horizontal scaling can all
 * violate it. Reusing the queue's shared `connection` (ioredis) makes the
 * lock correct regardless of how many worker processes are running.
 */
const LOCK_PREFIX = "patchpilot:live-response-lock:";

/**
 * Hard ceiling on how long one call may hold a device's exclusive lock — also
 * the lock's Redis TTL (PX), so a worker process that crashes or hangs
 * mid-call (e.g. MSAL/token resolution ahead of the first Graph call, which
 * has no narrower timeout of its own) releases the device automatically
 * instead of wedging it until someone restarts the process by hand. Set just
 * above JOB_TIMEOUT_MS (7 min, index.ts) so the job's own timeout is what
 * normally fires and marks the row failed; this is the belt-and-braces
 * backstop for when the hang is deeper than that.
 */
const DEVICE_LOCK_TIMEOUT_MS = 8 * 60_000;

const LOCK_POLL_INTERVAL_MS = 3_000;
// Long enough to wait out one full prior call (up to DEVICE_LOCK_TIMEOUT_MS)
// plus a little slack, rather than a short ceiling that would fail a job
// simply for being queued behind a legitimately slow — but healthy — one.
const LOCK_WAIT_TIMEOUT_MS = DEVICE_LOCK_TIMEOUT_MS + 30_000;

// Compare-and-delete: only removes the lock if it still holds OUR token, so a
// call whose TTL already expired (and was picked up by a new owner) can never
// delete an active lock out from under that new owner.
const RELEASE_LOCK_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

/** Best-effort "is this device locked right now" check, used only to decide
 *  whether to log the informational "queued behind it" line before blocking
 *  on acquireDeviceLock — never authoritative on its own. */
async function isDeviceLocked(machineId: string): Promise<boolean> {
  return (await connection.exists(LOCK_PREFIX + machineId)) === 1;
}

/** Blocks until this call owns the device's exclusive Redis lock, or throws
 *  after LOCK_WAIT_TIMEOUT_MS. Returns an opaque token that only this call may
 *  use to release it (see releaseDeviceLock). */
async function acquireDeviceLock(machineId: string): Promise<string> {
  const token = randomUUID();
  const key = LOCK_PREFIX + machineId;
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  for (;;) {
    const acquired = await connection.set(key, token, "PX", DEVICE_LOCK_TIMEOUT_MS, "NX");
    if (acquired === "OK") return token;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out after ${LOCK_WAIT_TIMEOUT_MS / 1000}s waiting for device ${machineId}'s Live Response ` +
          `lock — another job (in this worker process or another) is still holding it.`,
      );
    }
    await sleep(LOCK_POLL_INTERVAL_MS);
  }
}

async function releaseDeviceLock(machineId: string, token: string): Promise<void> {
  try {
    await connection.eval(RELEASE_LOCK_SCRIPT, 1, LOCK_PREFIX + machineId, token);
  } catch (err) {
    modLog.error({ err, machineId }, "failed to release device lock");
  }
}

async function runExclusiveByDevice<T>(machineId: string, fn: () => Promise<T>): Promise<T> {
  const token = await acquireDeviceLock(machineId);
  try {
    return await fn();
  } finally {
    await releaseDeviceLock(machineId, token);
  }
}

/**
 * Run the winget remediation on one device via Live Response and return the real
 * script exit code + output. Never fakes success: a Defender-side failure, a
 * non-terminal action past the poll ceiling, or a non-zero script exit all map to
 * a non-zero exitCode with an explanatory output.
 */
export async function runLiveResponseRemediation(input: LiveResponseInput): Promise<LiveResponseResult> {
  const { machineId, onProgress } = input;
  const progress = new ProgressLog(onProgress);

  if (await isDeviceLocked(machineId)) {
    await progress.log(
      `Another Live Response job is already running against device ${machineId} — Defender allows only one ` +
        `active session per device, so this job is queued behind it.`,
    );
  }
  return runExclusiveByDevice(machineId, () => runLiveResponseRemediationExclusive(input, progress));
}

async function runLiveResponseRemediationExclusive(
  input: LiveResponseInput,
  progress: ProgressLog,
): Promise<LiveResponseResult> {
  const { engineer, homeTenantId, tenantId, machineId, packageId, installScope, action } = input;
  const userScoped = installScope === "user";
  const uninstall = action === "uninstall";
  const verb = uninstall ? "uninstall" : "upgrade";
  const args = userScoped ? `${verb} ${packageId} user` : `${verb} ${packageId}`;

  const scriptName = await ensureLibraryScript(
    { engineer, homeTenantId, tenantId },
    {
      script: wingetLiveResponseLibraryScript(),
      prefix: "Winget",
      description: "PatchPilot parameterized winget remediation (auto-provisioned, generic).",
      parametersDescription:
        "Winget verb and args, e.g. 'upgrade 7zip.7zip', 'uninstall 7zip.7zip user', or 'list'.",
    },
    progress,
  );

  // Invoke the library script by name with the verb, the package id, and, for
  // a per-user install, a trailing "user" token — see
  // LiveResponseInput.installScope — as its Args string.
  return dispatchLibraryScript(
    { engineer, homeTenantId, tenantId, machineId },
    {
      scriptName,
      args,
      comment: `PatchPilot: winget ${verb} ${packageId}`,
      startingLog:
        `Requesting Live Response action on device ${machineId} (winget ${verb} ${packageId}` +
        (userScoped ? ", per-user via signed-in user" : "") +
        `)...`,
      failedLabel: packageId,
    },
    progress,
  );
}

export interface LiveResponseChocolateyInput {
  engineer: string;
  homeTenantId: string;
  tenantId: string;
  /** Defender machine id of the target device. */
  machineId: string;
  /** Chocolatey package id passed to the library script, e.g. "filezilla". */
  packageId: string;
  /** See LiveResponseInput.onProgress. */
  onProgress?: (transcript: string) => void | Promise<void>;
}

/**
 * Run the Chocolatey remediation on one device via Live Response — the
 * Chocolatey counterpart to runLiveResponseRemediation, dispatched when a
 * job's `source` is "chocolatey" (see RemediationJob.source in queue.ts).
 * Upgrade-only, no per-user routing: Chocolatey always installs machine-wide,
 * so none of the winget path's scheduled-task-as-logged-in-user complexity
 * applies here. Same per-device serialization as every other Live Response
 * dispatch (Defender allows only one active session per device).
 */
export async function runLiveResponseChocolateyRemediation(
  input: LiveResponseChocolateyInput,
): Promise<LiveResponseResult> {
  const { machineId, onProgress } = input;
  const progress = new ProgressLog(onProgress);

  if (await isDeviceLocked(machineId)) {
    await progress.log(
      `Another Live Response job is already running against device ${machineId} — Defender allows only one ` +
        `active session per device, so this job is queued behind it.`,
    );
  }
  return runExclusiveByDevice(machineId, () => runLiveResponseChocolateyRemediationExclusive(input, progress));
}

async function runLiveResponseChocolateyRemediationExclusive(
  input: LiveResponseChocolateyInput,
  progress: ProgressLog,
): Promise<LiveResponseResult> {
  const { engineer, homeTenantId, tenantId, machineId, packageId } = input;

  const scriptName = await ensureLibraryScript(
    { engineer, homeTenantId, tenantId },
    {
      script: chocolateyLiveResponseLibraryScript(),
      prefix: "Chocolatey",
      description: "PatchPilot parameterized Chocolatey remediation (auto-provisioned, generic).",
      parametersDescription: "Chocolatey verb and package id, e.g. 'upgrade filezilla'.",
    },
    progress,
  );

  return dispatchLibraryScript(
    { engineer, homeTenantId, tenantId, machineId },
    {
      scriptName,
      args: `upgrade ${packageId}`,
      comment: `PatchPilot: choco upgrade ${packageId}`,
      startingLog: `Requesting Live Response action on device ${machineId} (choco upgrade ${packageId})...`,
      failedLabel: packageId,
    },
    progress,
  );
}

interface GraphTarget {
  engineer: string;
  homeTenantId: string;
  tenantId: string;
  machineId: string;
}

interface DispatchOptions {
  /** Name of the already-provisioned library script to invoke. */
  scriptName: string;
  /** Args string for the RunScript command; omitted when the script takes none. */
  args?: string;
  /** Defender machine-action Comment field. */
  comment: string;
  /** Progress line logged right before the action is requested. */
  startingLog: string;
  /** Label used in the "finished non-Succeeded" log line. */
  failedLabel: string;
}

/**
 * Cancels a Defender machine action this process has given up polling on.
 * Defender enforces its own "one active Live Response session per device"
 * limit server-side, entirely independent of this file's own Redis-backed
 * lock — an action left "Pending"/"InProgress" (e.g. the device is
 * offline and never checks in within `POLL_TIMEOUT_MS`) keeps that slot held
 * on Defender's side indefinitely. Without this, every future job against the
 * device fails with HTTP 400 "ActiveRequestAlreadyExists" until an engineer
 * finds and cancels the action by hand in the Defender portal's Action center
 * — confirmed live: action 82996549-be0a-424e-9c9d-f1f2db298063 stuck
 * "Pending" against a device blocked every subsequent job for it.
 *
 * Best-effort: a failed cancel is logged, not thrown. The job this action
 * belonged to is already being reported as failed either way, and there is no
 * better fallback here than telling the engineer the device still needs a
 * manual look.
 */
async function cancelMachineAction(
  target: GraphTarget,
  actionId: string,
  progress: ProgressLog,
  comment = "PatchPilot: cancelled after giving up on confirmation (device did not check in within the poll window).",
): Promise<void> {
  const { engineer, homeTenantId, tenantId } = target;
  try {
    const cancelled = await graphWrite({
      engineer,
      homeTenantId,
      tenantId,
      host: "defender",
      method: "POST",
      path: `/machineactions/${actionId}/cancel`,
      body: { Comment: comment },
    });
    if (cancelled.ok) {
      await progress.log(`Action ${actionId} cancelled — the device's Live Response slot has been released.`);
    } else {
      await progress.log(
        `Could not cancel action ${actionId} (HTTP ${cancelled.status}) — it may already be past a cancellable ` +
          `state. If new jobs for this device keep failing with "already running", cancel it manually in the ` +
          `Defender portal's Action center.`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await progress.log(
      `Could not cancel action ${actionId} (${message}). If new jobs for this device keep failing with ` +
        `"already running", cancel it manually in the Defender portal's Action center.`,
    );
  }
}

/** Matches the action id Defender embeds in an ActiveRequestAlreadyExists
 *  error message, e.g. "Action is already in progress, active action id:
 *  b0ed2843-040f-4d40-ad12-977a9729a55d". */
const ACTIVE_ACTION_ID_RE = /active action id:\s*([0-9a-f-]{36})/i;

function extractActiveActionId(errorBody: string | null | undefined): string | null {
  if (!errorBody) return null;
  return errorBody.match(ACTIVE_ACTION_ID_RE)?.[1] ?? null;
}

/**
 * Invokes an already-provisioned Live Response library script and awaits its
 * result: request the action, poll to a terminal state, fetch the script's
 * real stdout/stderr from the SAS download link, and parse the
 * `PatchPilot-Exit` sentinel. Shared by both the winget (app) and WUA (OS/KB)
 * dispatch paths — everything past "which script and what args" is identical.
 */
async function dispatchLibraryScript(
  target: GraphTarget,
  opts: DispatchOptions,
  progress: ProgressLog,
): Promise<LiveResponseResult> {
  const { engineer, homeTenantId, tenantId, machineId } = target;
  const { scriptName, args, comment, startingLog, failedLabel } = opts;

  await progress.log(startingLog);
  const params = [{ key: "ScriptName", value: scriptName }];
  if (args !== undefined) params.push({ key: "Args", value: args });
  const started = await graphWrite<MachineAction>({
    engineer,
    homeTenantId,
    tenantId,
    host: "defender",
    method: "POST",
    path: `/machines/${machineId}/runliveresponse`,
    body: {
      Comment: comment,
      Commands: [{ type: "RunScript", params }],
    },
  });
  if (!started.ok || !started.data?.id) {
    // Defender's actual reason (e.g. "ActiveRequestAlreadyExists" for HTTP 400
    // when a stale/duplicate session is already open, vs. a real 5xx outage) —
    // surfaced instead of a blanket "may be disabled" guess, which previously
    // showed identically for every non-2xx status and made a genuine device
    // collision indistinguishable from Advanced Features actually being off.
    await progress.log(
      started.errorBody
        ? `Failed to start action (HTTP ${started.status}): ${started.errorBody}`
        : `Failed to start action (HTTP ${started.status}). Live Response may be disabled in the tenant's ` +
            `Advanced Features, or the device may already have an active session.`,
    );

    // Our own per-device lock (runExclusiveByDevice) only serializes calls
    // PatchPilot itself makes — it can't know about a session Defender is
    // holding for some other reason (an action from before this file's Redis
    // lock existed, one started outside PatchPilot in the Defender portal, or
    // one whose original caller crashed without reaching its own poll-timeout
    // cancel path below). Defender's ActiveRequestAlreadyExists error hands us
    // that blocking action's id directly, so cancel it now — confirmed live:
    // action b0ed2843-040f-4d40-ad12-977a9729a55d blocked every subsequent
    // job for a device with no automatic recovery until this was added.
    // Without this, every retry keeps failing the same way forever, requiring
    // an engineer to find and cancel it by hand in the Defender portal.
    const staleActionId = started.status === 400 ? extractActiveActionId(started.errorBody) : null;
    if (staleActionId) {
      await progress.log(
        `Clearing blocking action ${staleActionId} so the next job for this device isn't stuck behind it...`,
      );
      await cancelMachineAction(
        target,
        staleActionId,
        progress,
        "PatchPilot: cancelled a stale action reported by Defender as blocking a new Live Response request " +
          "(ActiveRequestAlreadyExists) for this device.",
      );
    }
    return { exitCode: 1, output: progress.text };
  }

  // Poll the machine action to a terminal state.
  const actionId = started.data.id;
  await progress.log(`Action ${actionId} accepted by Defender — waiting for the device to check in and run it.`);
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let status = started.data.status || "Pending";
  let lastLoggedStatus = status;
  while (!TERMINAL_STATUSES.has(status)) {
    if (Date.now() > deadline) {
      await progress.log(
        `Action ${actionId} still "${status}" after ${POLL_TIMEOUT_MS / 1000}s — giving up on confirmation. ` +
          `The device may be offline, slow to check in, or Live Response may be stalled; check machineaction ${actionId} in Defender.`,
      );
      await cancelMachineAction(target, actionId, progress);
      return { exitCode: 1, output: progress.text };
    }
    await sleep(POLL_INTERVAL_MS);
    const polled = await graphGet<MachineAction>({
      engineer,
      homeTenantId,
      tenantId,
      host: "defender",
      path: `/machineactions/${actionId}`,
    });
    if (polled.ok && polled.data?.status) status = polled.data.status;
    // Log on every status change, plus a periodic heartbeat so "still Pending"
    // reads as "still polling, nothing has changed" rather than a dead worker.
    const elapsedS = Math.round((POLL_TIMEOUT_MS - (deadline - Date.now())) / 1000);
    if (status !== lastLoggedStatus) {
      await progress.log(`Action ${actionId} status changed: ${lastLoggedStatus} -> ${status} (${elapsedS}s elapsed).`);
      lastLoggedStatus = status;
    } else {
      await progress.log(`Action ${actionId} still ${status} (${elapsedS}s elapsed)...`);
    }
  }

  if (status !== "Succeeded") {
    await progress.log(`Action ${actionId} finished "${status}" for ${failedLabel} — treating as failed.`);
    return { exitCode: 1, output: progress.text };
  }

  // Resolve the RunScript result (command index 0) and fetch it from the SAS URL.
  await progress.log(`Action ${actionId} succeeded — fetching the script's output...`);
  const link = await graphGet<{ value?: string }>({
    engineer,
    homeTenantId,
    tenantId,
    host: "defender",
    path: `/machineactions/${actionId}/GetLiveResponseResultDownloadLink(index=0)`,
  });
  if (!link.ok || !link.data?.value) {
    await progress.log(
      `Result output unavailable (HTTP ${link.status}) — the Defender action reported "Succeeded" ` +
        `(the command was delivered and ran), but that does not confirm the script's own exit code, ` +
        `so this is NOT reported as a success.`,
    );
    return { exitCode: 1, output: progress.text };
  }

  // The download link is a pre-signed SAS URL — fetched WITHOUT the bearer token.
  // Bounded and logged: an unbounded/silent fetch here previously let a hung or
  // failed download masquerade as exitCode 0 (a false "succeeded").
  let result: ScriptResult;
  try {
    const res = await fetch(link.data.value, { signal: AbortSignal.timeout(RESULT_FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      await progress.log(
        `Fetching the script's output failed (HTTP ${res.status}) — the Defender action Succeeded, ` +
          `but the real exit code is unknown, so this is NOT reported as a success.`,
      );
      return { exitCode: 1, output: progress.text };
    }
    result = (await res.json()) as ScriptResult;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await progress.log(
      `Fetching the script's output failed (${message}) — the Defender action Succeeded, but the real ` +
        `exit code is unknown, so this is NOT reported as a success.`,
    );
    return { exitCode: 1, output: progress.text };
  }

  // Sanitized before it touches the transcript: this is raw stdout/stderr from the
  // device, and a process emitting UTF-16LE lands here full of NUL bytes, which
  // Postgres refuses outright (22021). Unsanitized, that error broke the worker's
  // terminal-status write and stranded the job at "running" — see sanitizeDbText.
  const outputBody = sanitizeDbTextBounded(
    [result.script_output, result.script_errors].filter(Boolean).join("\n").trim(),
  );

  const sentinel = parseVerdict(outputBody);
  if (sentinel === null) {
    // Deliberately NOT falling back to result.exit_code — that is the bug this
    // replaced, not a safety net. See parseVerdict.
    await progress.log(
      `The script did not publish a PatchPilot-Exit verdict, so whether the device was ` +
        `patched is unknown and this is NOT reported as a success ` +
        `(Defender reported exit_code ${String(result.exit_code)}, which is not the script's own exit code).` +
        (outputBody ? `\n${outputBody}` : ""),
    );
    return { exitCode: 1, output: progress.text };
  }

  await progress.log(`Script exit ${sentinel}.` + (outputBody ? `\n${outputBody}` : ""));
  return { exitCode: sentinel, output: progress.text };
}

/**
 * Ensures the WUA remediation script for one specific KB is present in the
 * tenant's Live Response library, uploading it if absent. One file per KB
 * (content-addressed), since generateWuaRemediationCom bakes the KB id into
 * the script body rather than taking it as an Args token.
 */
async function ensureKbLibraryScript(
  input: { engineer: string; homeTenantId: string; tenantId: string; kbId: string },
  progress: ProgressLog,
): Promise<string> {
  const { engineer, homeTenantId, tenantId, kbId } = input;
  return ensureLibraryScript(
    { engineer, homeTenantId, tenantId },
    {
      script: generateWuaRemediationCom({ kbId }),
      prefix: "WUA",
      description: `PatchPilot Windows Update remediation for KB${kbId} (auto-provisioned).`,
    },
    progress,
  );
}

export interface LiveResponseKbInput {
  engineer: string;
  homeTenantId: string;
  tenantId: string;
  /** Defender machine id of the target device. */
  machineId: string;
  /** Defender missing-KB id (no "KB" prefix), e.g. "5040442". */
  kbId: string;
  /** See LiveResponseInput.onProgress. */
  onProgress?: (transcript: string) => void | Promise<void>;
}

/**
 * Run a Windows Update KB install on one device via Live Response — the OS/KB
 * counterpart to runLiveResponseRemediation. Structurally identical (same
 * upload/poll/fetch-result/parseVerdict machinery via dispatchLibraryScript),
 * but the script is the native WUA COM installer for one specific KB rather
 * than the generic parameterized winget script, and needs no Args token since
 * the KB is baked into the script body. Same per-device serialization applies
 * (Defender allows only one active Live Response session per device).
 */
export async function runLiveResponseKbRemediation(input: LiveResponseKbInput): Promise<LiveResponseResult> {
  const { machineId, onProgress } = input;
  const progress = new ProgressLog(onProgress);

  if (await isDeviceLocked(machineId)) {
    await progress.log(
      `Another Live Response job is already running against device ${machineId} — Defender allows only one ` +
        `active session per device, so this job is queued behind it.`,
    );
  }
  return runExclusiveByDevice(machineId, () => runLiveResponseKbRemediationExclusive(input, progress));
}

async function runLiveResponseKbRemediationExclusive(
  input: LiveResponseKbInput,
  progress: ProgressLog,
): Promise<LiveResponseResult> {
  const { engineer, homeTenantId, tenantId, machineId, kbId } = input;

  const scriptName = await ensureKbLibraryScript({ engineer, homeTenantId, tenantId, kbId }, progress);

  return dispatchLibraryScript(
    { engineer, homeTenantId, tenantId, machineId },
    {
      scriptName,
      comment: `PatchPilot: install KB${kbId}`,
      startingLog: `Requesting Live Response action on device ${machineId} (Windows Update KB${kbId})...`,
      failedLabel: `KB${kbId}`,
    },
    progress,
  );
}

/**
 * Reads the verdict the library script published on stdout, or `null` if it never
 * got that far.
 *
 * Defender's `exit_code` cannot be used for this. Proven on a live run: the script
 * executed `exit 4` — its exit-4-only messages are in the transcript — and the API
 * still returned `exit_code: 0`, so the worker mapped a device that was never
 * patched to "succeeded". A PowerShell script's exit code simply does not travel off
 * the device through Live Response, so the script prints `PatchPilot-Exit: <n>`
 * instead and this parses it back out.
 *
 * The LAST match wins: the script's single exit path emits the sentinel as its final
 * line, so anything resembling one earlier in the transcript is device output being
 * echoed, not a verdict. `null` (no sentinel at all) means the script died before
 * reaching its exit path, which the caller must treat as a failure — an unknown
 * outcome is never a success.
 */
function parseVerdict(output: string): number | null {
  const matches = [...output.matchAll(/^PatchPilot-Exit:\s*(-?\d+)\s*$/gm)];
  const last = matches.at(-1);
  return last ? Number(last[1]) : null;
}
