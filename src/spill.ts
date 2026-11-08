import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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

/** Spill files are deleted this many days after the end of the UTC day they were written. */
export const DEFAULT_SPILL_RETENTION_DAYS = 14;

/**
 * Time between two sweeps of one directory. Shared by every omp process through the
 * `.last-prune` marker, best-effort: two processes may rarely both sweep (harmless).
 */
export const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
/** A day folder: payloads first written that UTC day. */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Pre-0.2.0 layout, spills directly in the directory: `<hash>.txt` and crashed-write leftovers. */
const LEGACY_RE = /^[0-9a-f]{16}\.txt(\.\d+\.[0-9a-f]+\.tmp)?$/;
const LAST_SWEEP = '.last-prune';

const unique = () => `${process.pid}.${randomBytes(4).toString('hex')}`;
const utcDay = (time: number) => new Date(time).toISOString().slice(0, 10);

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
 * instead. Identical payloads spilled on the same day collapse onto the same
 * file, so a result read twice costs one copy.
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
  /**
   * Payloads go into a folder for the day they are written, and the sweep only deletes
   * whole day folders past retention. So a sweep never touches a folder a spill can be
   * writing to, and a notice just returned cannot lose its file to a concurrent sweep.
   */
  const day = join(dir, utcDay(Date.now()));
  const path = join(day, `${digest}.txt`);

  mkdirSync(day, { recursive: true });
  // Write to a temporary name and rename it into place, so the named file is always complete.
  const tmp = `${path}.${unique()}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
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

/**
 * Deletes spill files older than `maxAgeMs` and returns how many it removed. Touches only
 * `YYYY-MM-DD` day folders and the pre-0.2.0 `<hash>.txt` files beside them; anything else
 * in the directory is left alone.
 *
 * A day folder is removed whole once its last possible write (the end of that UTC day) is
 * older than `maxAgeMs`, so every file in it is past retention and no spill, which only
 * writes today's folder, can be adding to it. Legacy files are judged one by one by age;
 * only omp processes still running an older version of this plugin write those.
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
    const path = join(dir, name);
    try {
      if (DAY_RE.test(name)) {
        const end = Date.parse(`${name}T00:00:00Z`) + DAY_MS;
        if (!(now - end > maxAgeMs)) continue;
        const files = readdirSync(path).filter((f) => f.endsWith('.txt')).length;
        rmSync(path, { recursive: true, force: true });
        removed += files;
      } else if (LEGACY_RE.test(name)) {
        if (now - statSync(path).mtimeMs <= maxAgeMs) continue;
        unlinkSync(path);
        if (name.endsWith('.txt')) removed++;
      }
    } catch {
      // Gone already, or not ours to read: leave it for a later sweep.
    }
  }
  return removed;
}

/** Time of the last sweep of `dir`, or 0 if none or unreadable. */
function lastSweep(dir: string): number {
  try {
    const time = Number.parseInt(readFileSync(join(dir, LAST_SWEEP), 'utf8'), 10);
    return Number.isFinite(time) ? time : 0;
  } catch {
    return 0;
  }
}

/**
 * Sweeps `dir` when at least PRUNE_INTERVAL_MS has passed since its last sweep, whichever
 * process gets there first. Two processes may occasionally both sweep; that is harmless,
 * because a sweep only removes what is already past retention. Never throws: losing a
 * sweep only delays cleanup, while an exception here would break compaction.
 */
export function maybePruneSpill(dir: string, retentionDays: number, now: number = Date.now()): number {
  if (!(retentionDays > 0)) return 0;
  try {
    if (Math.abs(now - lastSweep(dir)) < PRUNE_INTERVAL_MS) return 0;
    // Claim the interval before sweeping, so other processes skip it.
    writeFileSync(join(dir, LAST_SWEEP), `${now}\n`);
    return pruneSpill(dir, retentionDays * DAY_MS, now);
  } catch {
    return 0;
  }
}
