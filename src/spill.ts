import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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

const PRUNE_MARKER = '.last-prune';

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
  writeFileSync(path, text);
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
 * Deletes `<hash>.txt` spill files whose last write is older than `maxAgeMs`.
 * Touches nothing else in the directory. Returns how many files were removed.
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
    if (!/^[0-9a-f]{16}\.txt$/.test(name)) continue;
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > maxAgeMs) {
        unlinkSync(path);
        removed++;
      }
    } catch {
      // Another process removed or rewrote it meanwhile; either way it is not ours to fix.
    }
  }
  return removed;
}

/**
 * Sweeps `dir` at most once per PRUNE_INTERVAL_MS, shared across processes through a
 * marker file whose time is claimed before sweeping. Never throws: losing a sweep only
 * delays cleanup, while an exception here would break compaction.
 */
export function maybePruneSpill(dir: string, retentionDays: number, now: number = Date.now()): number {
  if (!(retentionDays > 0)) return 0;
  const marker = join(dir, PRUNE_MARKER);
  try {
    try {
      if (now - statSync(marker).mtimeMs < PRUNE_INTERVAL_MS) return 0;
    } catch {
      // No marker yet: first sweep.
    }
    writeFileSync(marker, new Date(now).toISOString());
    return pruneSpill(dir, retentionDays * 24 * 60 * 60 * 1000, now);
  } catch {
    return 0;
  }
}
