import os from "node:os";
import fs from "node:fs";

/**
 * Host resource sampling for Settings > Server Health's Resources tab.
 *
 * Uses only Node's built-in `os`/`fs` — no new dependency, and `fs.statfsSync`
 * has been stable since Node 18.15/19.6, well under this repo's `node:22-alpine`
 * base image (see infra/Dockerfile.api / Dockerfile.worker).
 *
 * IMPORTANT — unverified assumption, flagged for live testing on the real
 * Azure VM: this reads `/proc`/`os.cpus()` from *inside* the `api` container.
 * A typical Docker Compose setup does not namespace procfs/sysfs the way it
 * namespaces the filesystem or network stack, so these numbers are expected
 * to reflect the true host values — but that has not been confirmed against
 * this app's actual container runtime. Compare against `docker stats` /
 * `free -m` / `df -h` run directly on the VM before trusting this in
 * production (see the Server Health plan's verification section).
 *
 * Network and disk-IO *throughput* are deliberately not sampled here: a
 * container's own network interface is virtual and not the host's NIC, and
 * there is no reliable way to read real host I/O without the Docker socket
 * access that only the `updater` sidecar has (Phase 2).
 */

export interface CpuSample {
  /** 0-100. Null on the very first call — a percentage needs two points in
   *  time, and there's nothing to diff against yet. */
  percent: number | null;
  cores: number;
}

export interface MemorySample {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  percent: number;
}

export interface DiskSample {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  percent: number;
}

interface CpuTimes {
  idle: number;
  total: number;
}

function readCpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const time of Object.values(cpu.times)) {
      total += time;
    }
    idle += cpu.times.idle;
  }
  return { idle, total };
}

// Module-level so consecutive samples (across separate requests) diff against
// each other rather than each request measuring an instantaneous, meaningless
// single-tick snapshot.
let previousCpuTimes: CpuTimes | null = null;

export function sampleCpuPercent(): CpuSample {
  const current = readCpuTimes();
  const cores = os.cpus().length;

  if (!previousCpuTimes) {
    previousCpuTimes = current;
    return { percent: null, cores };
  }

  const idleDelta = current.idle - previousCpuTimes.idle;
  const totalDelta = current.total - previousCpuTimes.total;
  previousCpuTimes = current;

  if (totalDelta <= 0) return { percent: null, cores };
  const percent = Math.max(0, Math.min(100, 100 * (1 - idleDelta / totalDelta)));
  return { percent, cores };
}

export function sampleMemory(): MemorySample {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = totalBytes - freeBytes;
  return { totalBytes, freeBytes, usedBytes, percent: totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0 };
}

/** Null on failure (e.g. statfs unsupported on the host platform) rather than
 *  throwing — a missing disk reading shouldn't take down the whole panel. */
export function sampleDisk(path = "/"): DiskSample | null {
  try {
    const stats = fs.statfsSync(path);
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bfree * stats.bsize;
    const usedBytes = totalBytes - freeBytes;
    return { totalBytes, freeBytes, usedBytes, percent: totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0 };
  } catch {
    return null;
  }
}
