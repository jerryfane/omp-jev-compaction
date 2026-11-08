import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import type * as Fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { maybePruneSpill, pruneSpill, spillPayload } from '../src/spill.js';

/**
 * Another omp process acting between two of the sweeper's filesystem calls, made
 * deterministic: `statSync` runs the queued action once, right after it returns.
 * vi.mock is hoisted above the imports, so src/spill.ts sees these wrappers.
 */
const between = vi.hoisted(() => ({
  action: undefined as undefined | ((path: string) => void),
  readdirs: 0,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  return {
    ...actual,
    statSync: ((path: Fs.PathLike, ...rest: unknown[]) => {
      const result = (actual.statSync as (...a: unknown[]) => unknown)(path, ...rest);
      const action = between.action;
      if (action) {
        between.action = undefined;
        action(String(path));
      }
      return result;
    }) as typeof actual.statSync,
    readdirSync: ((...args: unknown[]) => {
      between.readdirs++;
      return (actual.readdirSync as (...a: unknown[]) => unknown)(...args);
    }) as typeof actual.readdirSync,
  };
});

const DAY = 24 * 60 * 60 * 1000;
const dir = () => mkdtempSync(join(tmpdir(), 'jev-spill-race-'));
const age = (path: string, days: number, now: number) => {
  const t = (now - days * DAY) / 1000;
  utimesSync(path, t, t);
};

describe('spill pruning under concurrent processes', () => {
  it('keeps a payload that another process re-spilled after the sweeper found it expired', () => {
    const d = dir();
    const now = Date.now();
    const text = `payload\n${'x'.repeat(2000)}`;
    const { path } = spillPayload(text, { dir: d, retentionDays: 0 });
    age(path, 20, now);

    let returned = '';
    between.action = () => {
      returned = spillPayload(text, { dir: d, retentionDays: 0 }).path;
    };
    pruneSpill(d, 14 * DAY, now);

    expect(returned).toBe(path);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(text);
  });

  it('lets only one of two processes sweep in the same interval', () => {
    const d = dir();
    const now = Date.now();
    const old = spillPayload(`old\n${'x'.repeat(2000)}`, { dir: d, retentionDays: 0 }).path;
    age(old, 20, now);
    // An earlier sweep ran two hours ago, so both processes see the interval as expired.
    for (const marker of ['.last-prune', `.prune-slot-${Math.floor(now / (60 * 60 * 1000)) - 2}`]) {
      writeFileSync(join(d, marker), '');
      age(join(d, marker), 2 / 24, now);
    }
    between.readdirs = 0;
    let second = -1;
    between.action = () => {
      second = maybePruneSpill(d, 14, now);
    };
    const first = maybePruneSpill(d, 14, now);

    expect(first + second).toBe(1);
    expect(between.readdirs).toBe(1);
    expect(existsSync(old)).toBe(false);
  });
});
