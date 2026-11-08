import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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

/** How often one directory is swept, across every omp process sharing it. */
export const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

const SPILL_RE = /^[0-9a-f]{16}\.txt$/;
/** Leftovers of a crashed write (`<hash>.txt.<pid>.<rand>.tmp`) or prune (`.prune-<hash>.txt.<pid>.<rand>`). */
const LEFTOVER_RE = /^(?:[0-9a-f]{16}\.txt\.\d+\.[0-9a-f]+\.tmp|\.prune-[0-9a-f]{16}\.txt\.\d+\.[0-9a-f]+)$/;
/** One empty file per sweep hour; whoever creates it exclusively owns that hour's sweep. */
const SLOT_RE = /^\.prune-slot-\d+$/;

const unique = () => `${process.pid}.${randomBytes(4).toString('hex')}`;

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
  /**
   * Write to a temporary name and rename it into place, so the named file is always
   * complete and a re-spill always installs a fresh file. pruneSpill relies on that to
   * tell a refreshed payload from an expired one.
   */
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
 * Deletes `<hash>.txt` spill files whose last write is older than `maxAgeMs`, and stale
 * leftovers of crashed writes or sweeps. Touches nothing else in the directory. Returns
 * how many spill files were removed.
 *
 * An expired file is first moved aside and checked again before it is deleted. A process
 * that re-spills the same payload meanwhile renames a fresh file into place: if that
 * happened before the move, the moved file is fresh and goes back; if after, the fresh
 * file stays at the path and only the old one is deleted. Either way a notice that was
 * just returned keeps pointing at its payload.
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
    if (LEFTOVER_RE.test(name) || SLOT_RE.test(name)) {
      try {
        if (now - statSync(path).mtimeMs > 2 * PRUNE_INTERVAL_MS) unlinkSync(path);
      } catch {
        // Gone already.
      }
      continue;
    }
    if (!SPILL_RE.test(name)) continue;
    try {
      if (now - statSync(path).mtimeMs <= maxAgeMs) continue;
    } catch {
      continue;
    }
    const aside = join(dir, `.prune-${name}.${unique()}`);
    try {
      renameSync(path, aside);
    } catch {
      continue; // Another sweeper took it, or it is gone.
    }
    try {
      if (now - statSync(aside).mtimeMs <= maxAgeMs) {
        renameSync(aside, path); // Refreshed before we moved it: put it back.
        continue;
      }
      unlinkSync(aside);
      removed++;
    } catch {
      // Left for the leftover cleanup of a later sweep.
    }
  }
  return removed;
}

/**
 * Sweeps `dir` at most once per PRUNE_INTERVAL_MS across every process sharing it: the
 * sweep for an hour belongs to whoever exclusively creates that hour's slot file. Never
 * throws: losing a sweep only delays cleanup, while an exception here would break
 * compaction.
 */
export function maybePruneSpill(dir: string, retentionDays: number, now: number = Date.now()): number {
  if (!(retentionDays > 0)) return 0;
  try {
    writeFileSync(join(dir, `.prune-slot-${Math.floor(now / PRUNE_INTERVAL_MS)}`), '', { flag: 'wx' });
  } catch {
    return 0; // This hour is already claimed (or the directory is not writable).
  }
  try {
    return pruneSpill(dir, retentionDays * 24 * 60 * 60 * 1000, now);
  } catch {
    return 0;
  }
}
