import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
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

export interface SpillOptions {
  dir?: string;
  /** Characters of the head kept inline before the pointer. */
  headChars?: number;
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
