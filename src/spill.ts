import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where dropped tool output is parked so it can be read back.
 *
 * Reduction without recovery is a hole: the measured recall test showed a
 * reduced context answering 63-75% of questions that full context answered
 * 100% of. Writing the payload to a plain file and naming that file in the
 * note turns a permanent loss into one `read` call, using the agent's own
 * tool rather than a scheme it would have to be taught.
 */
export const DEFAULT_SPILL_DIR = join(homedir(), '.omp', 'jev-spill');

/** Spill files older than this are deleted. Re-spilling an identical payload refreshes its age. */
export const DEFAULT_SPILL_RETENTION_DAYS = 14;

/** Minimum time between two sweeps of one directory, across every omp process sharing it. */
export const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** A sweep lock older than this belongs to a sweeper that died; it may be taken over. */
export const SWEEP_LOCK_STALE_MS = 5 * 60 * 1000;

/** Longest a spill waits for another process's sweep before repairing its file anyway. */
export const SWEEP_WAIT_MS = 10 * 1000;

const SPILL_RE = /^[0-9a-f]{16}\.txt$/;
/** Leftover of a crashed write: `<hash>.txt.<pid>.<rand>.tmp`. */
const TMP_RE = /^[0-9a-f]{16}\.txt\.\d+\.[0-9a-f]+\.tmp$/;
const SWEEP_LOCK = '.sweep.lock';
const LAST_SWEEP = '.last-prune';

const unique = () => `${process.pid}.${randomBytes(4).toString('hex')}`;
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms: number) => Atomics.wait(sleepBuffer, 0, 0, ms);

export interface SpillOptions {
  dir?: string;
  /** Characters of the head kept inline before the pointer. */
  headChars?: number;
  /** Delete spill files older than this many days; 0 keeps them forever. */
  retentionDays?: number;
}

export interface SpilledPayload {
  path: string;
  chars: number;
  /** The replacement text: head, then where to get the rest. */
  notice: string;
}

/**
 * Writes `text` to a content-addressed file and returns the note to show
 * instead. Identical payloads collapse onto the same file, so a result read
 * twice costs one copy.
 */
export function spillPayload(text: string, options: SpillOptions = {}): SpilledPayload {
  const dir = options.dir ?? DEFAULT_SPILL_DIR;
  const headChars = options.headChars ?? 300;

  /**
   * A payload no bigger than the head plus the notice saves nothing: parking
   * it would produce a longer replacement (and a nonsense negative count).
   */
  if (text.length <= headChars + 160) {
    return { path: '', chars: text.length, notice: text };
  }

  const digest = createHash('sha256').update(text).digest('hex').slice(0, 16);
  const path = join(dir, `${digest}.txt`);

  mkdirSync(dir, { recursive: true });
  // Write to a temporary name and rename it into place, so the named file is always complete.
  const sweepBefore = sweepMarker(dir);
  const tmp = `${path}.${unique()}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
  ensureSurvivesSweep(dir, path, text, sweepBefore);
  maybePruneSpill(dir, options.retentionDays ?? DEFAULT_SPILL_RETENTION_DAYS);

  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : '';
  return {
    path,
    chars: text.length,
    notice:
      `${head}[jev elided ${text.length - headChars} of ${text.length} chars of this tool result. ` +
      `The full output is still available: read ${path}]`,
  };
}

/**
 * True when the text is one of our notices, so a second pass does not spill a
 * pointer as if it were a payload.
 */
export function isSpillNotice(text: string): boolean {
  return text.includes('[jev elided ') && text.includes('read ');
}

/** The pid holding `dir`'s sweep lock, or undefined when it is free or stale. */
function sweepHolder(dir: string): string | undefined {
  const lock = join(dir, SWEEP_LOCK);
  try {
    if (Date.now() - statSync(lock).mtimeMs > SWEEP_LOCK_STALE_MS) return undefined;
    return readFileSync(lock, 'utf8').trim() || '?';
  } catch {
    return undefined;
  }
}

/** Content of `dir`'s last-sweep marker; every completed sweep writes a new, unique one. */
function sweepMarker(dir: string): string {
  try {
    return readFileSync(join(dir, LAST_SWEEP), 'utf8');
  } catch {
    return '';
  }
}

/**
 * Closes the race with a concurrent sweep, which could delete the file just renamed into
 * place if it read that path's old age first. Such a sweep held the lock across the
 * rename, so after the rename it either still holds the lock, or has released it after
 * writing a new last-sweep marker. In either case wait for it to finish, then put the
 * file back if it is gone. A sweep in this same process cannot be running (both are
 * synchronous), so only another process's lock is waited for.
 */
function ensureSurvivesSweep(dir: string, path: string, text: string, sweepBefore: string): void {
  const holder = sweepHolder(dir);
  const otherSweep = holder !== undefined && holder !== String(process.pid);
  if (!otherSweep && sweepMarker(dir) === sweepBefore) return;
  const until = Date.now() + SWEEP_WAIT_MS;
  while (sweepHolder(dir) !== undefined && Date.now() < until) sleep(25);
  try {
    statSync(path);
  } catch {
    const tmp = `${path}.${unique()}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  }
}

/**
 * Deletes `<hash>.txt` spill files whose last write is older than `maxAgeMs`, and stale
 * temporary files of crashed writes. Touches nothing else in the directory. Returns how
 * many spill files were removed. Callers outside tests should use maybePruneSpill, which
 * holds the sweep lock that makes this safe against concurrent spills.
 */
export function pruneSpill(dir: string, maxAgeMs: number, now: number = Date.now()): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const spill = SPILL_RE.test(name);
    if (!spill && !TMP_RE.test(name)) continue;
    const path = join(dir, name);
    try {
      const limit = spill ? maxAgeMs : SWEEP_LOCK_STALE_MS;
      if (now - statSync(path).mtimeMs <= limit) continue;
      unlinkSync(path);
      if (spill) removed++;
    } catch {
      // Gone already.
    }
  }
  return removed;
}

/** Takes `dir`'s sweep lock, taking over a stale one. True when this process now holds it. */
function takeSweepLock(dir: string): boolean {
  const lock = join(dir, SWEEP_LOCK);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx' });
      return true;
    } catch {
      try {
        if (attempt > 0 || Date.now() - statSync(lock).mtimeMs <= SWEEP_LOCK_STALE_MS) return false;
        unlinkSync(lock);
      } catch {
        // Released meanwhile: try again.
      }
    }
  }
  return false;
}

/** Time of the last completed sweep of `dir`, or 0 if none or unreadable. */
function lastSweep(dir: string): number {
  const time = Number.parseInt(sweepMarker(dir), 10);
  return Number.isFinite(time) ? time : 0;
}

/**
 * Sweeps `dir` when at least PRUNE_INTERVAL_MS has passed since its last completed sweep,
 * whichever process gets there first. The sweep holds an exclusive lock so concurrent
 * spills can protect what they just wrote (see ensureSurvivesSweep). Never throws: losing
 * a sweep only delays cleanup, while an exception here would break compaction.
 */
export function maybePruneSpill(dir: string, retentionDays: number, now: number = Date.now()): number {
  if (!(retentionDays > 0)) return 0;
  try {
    if (Math.abs(now - lastSweep(dir)) < PRUNE_INTERVAL_MS) return 0;
    if (!takeSweepLock(dir)) return 0;
  } catch {
    return 0;
  }
  try {
    // Another process may have finished a sweep between our check and taking the lock.
    if (Math.abs(now - lastSweep(dir)) < PRUNE_INTERVAL_MS) return 0;
    const removed = pruneSpill(dir, retentionDays * 24 * 60 * 60 * 1000, now);
    writeFileSync(join(dir, LAST_SWEEP), `${now} ${unique()}\n`);
    return removed;
  } catch {
    return 0;
  } finally {
    try {
      unlinkSync(join(dir, SWEEP_LOCK));
    } catch {
      // Already gone.
    }
  }
}
