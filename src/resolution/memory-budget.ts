/**
 * Available memory for worker-pool sizing.
 *
 * `os.freemem()` is not cgroup-aware on Linux and under-counts reclaimable
 * pages on macOS. Keep the policy in one place so resolver admission uses the
 * memory the process can actually consume rather than the host-wide value.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';

/** Parse a cgroup byte counter, treating an absent/unlimited value as null. */
function readCgroupBytes(filePath: string): number | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (raw === 'max') return null;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

/** Reclaimable page cache reported by a cgroup memory.stat file. */
function readInactiveFile(statPath: string): number {
  try {
    const match = /^inactive_file (\d+)$/m.exec(fs.readFileSync(statPath, 'utf8'));
    return match ? Number.parseInt(match[1]!, 10) : 0;
  } catch {
    return 0;
  }
}

/**
 * Available headroom under a Linux cgroup limit, or null when uncontained.
 * Reclaimable inactive file pages are credited back, matching the working-set
 * convention used by container monitoring tools.
 */
export function cgroupMemoryAvailable(): number | null {
  if (process.platform !== 'linux') return null;

  const v2Limit = readCgroupBytes('/sys/fs/cgroup/memory.max');
  if (v2Limit !== null) {
    const current = readCgroupBytes('/sys/fs/cgroup/memory.current') ?? 0;
    const reclaimable = readInactiveFile('/sys/fs/cgroup/memory.stat');
    return Math.max(0, v2Limit - Math.max(0, current - reclaimable));
  }

  const v1Limit = readCgroupBytes('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  // Cgroup v1 represents "unlimited" with a very large sentinel value.
  if (v1Limit !== null && v1Limit < 2 ** 60) {
    const usage = readCgroupBytes('/sys/fs/cgroup/memory/memory.usage_in_bytes') ?? 0;
    const reclaimable = readInactiveFile('/sys/fs/cgroup/memory/memory.stat');
    return Math.max(0, v1Limit - Math.max(0, usage - reclaimable));
  }

  return null;
}

/** Reclaimable-inclusive available memory on macOS, or null elsewhere. */
export function darwinMemoryAvailable(): number | null {
  if (process.platform !== 'darwin') return null;
  try {
    const output = execFileSync('/usr/bin/vm_stat', {
      encoding: 'utf8',
      timeout: 2_000,
    });
    const pageMatch = /page size of (\d+) bytes/.exec(output);
    const pageSize = pageMatch ? Number.parseInt(pageMatch[1]!, 10) : 16_384;
    const pageCount = (label: string): number => {
      const match = new RegExp(`^${label}:\\s+(\\d+)`, 'm').exec(output);
      return match ? Number.parseInt(match[1]!, 10) : 0;
    };
    const pages =
      pageCount('Pages free') +
      pageCount('Pages inactive') +
      pageCount('Pages speculative') +
      pageCount('Pages purgeable');
    const bytes = pages * pageSize;
    return bytes > 0 && Number.isFinite(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

/** Conservative memory budget used when deciding resolver worker count. */
export function memoryBudgetBytes(): number {
  const free = os.freemem();
  const cgroup = cgroupMemoryAvailable();
  if (cgroup !== null) return Math.min(free, cgroup);

  const darwin = darwinMemoryAvailable();
  return darwin === null ? free : Math.max(free, darwin);
}
