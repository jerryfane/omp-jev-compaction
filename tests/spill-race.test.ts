import { existsSync, mkdtempSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import type * as Fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { maybePruneSpill, PRUNE_INTERVAL_MS, spillPayload } from '../src/spill.js';

/**
 * Another omp process acting between two filesystem calls of this one, made deterministic:
 * a queued hook runs once, right after the first matching call returns. vi.mock is hoisted
 * above the imports, so src/spill.ts sees these wrappers.
 */
type Hook = { fn: 'statSync' | 'renameSync'; match: (path: string) => boolean; action: () => void };
const between = vi.hoisted(() => ({ hooks: [] as Hook[], readdirs: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  const after = (fn: Hook['fn'], path: string) => {
    const i = between.hooks.findIndex((h) => h.fn === fn && h.match(path));
    if (i >= 0) between.hooks.splice(i, 1)[0].action();
  };
  return {
    ...actual,
    statSync: ((path: Fs.PathLike, ...rest: unknown[]) => {
      const result = (actual.statSync as (...a: unknown[]) => unknown)(path, ...rest);
      after('statSync', String(path));
      return result;
    }) as typeof actual.statSync,
    renameSync: ((from: Fs.PathLike, to: Fs.PathLike) => {
      actual.renameSync(from, to);
      after('renameSync', String(to));
    }) as typeof actual.renameSync,
    readdirSync: ((...args: unknown[]) => {
      between.readdirs++;
      return (actual.readdirSync as (...a: unknown[]) => unknown)(...args);
    }) as typeof actual.readdirSync,
  };
});

const DAY = 24 * 60 * 60 * 1000;
const dir = () => mkdtempSync(join(tmpdir(), 'jev-spill-race-'));
const age = (path: string, ms: number) => {
  const t = (Date.now() - ms) / 1000;
  utimesSync(path, t, t);
};
const text = `payload\n${'x'.repeat(2000)}`;
/** What another process's sweep leaves when it finishes: a new marker, no lock. */
const finishOtherSweep = (d: string) => {
  writeFileSync(join(d, '.last-prune'), `${Date.now()} 999999.other\n`);
  unlinkSync(join(d, '.sweep.lock'));
};

describe('spill pruning under concurrent processes', () => {
  it('restores a payload that another sweep deleted and finished with while it was being re-spilled', () => {
    const d = dir();
    const { path } = spillPayload(text, { dir: d, retentionDays: 0 });
    // Another process holds the sweep lock and has already judged this file expired.
    writeFileSync(join(d, '.sweep.lock'), '999999');
    between.hooks.push({
      fn: 'renameSync',
      match: (p) => p === path,
      action: () => {
        unlinkSync(path); // its unlink lands just after our rename,
        finishOtherSweep(d); // and it finishes before we look at the lock.
      },
    });

    const returned = spillPayload(text, { dir: d, retentionDays: 0 }).path;

    expect(returned).toBe(path);
    expect(readFileSync(path, 'utf8')).toBe(text);
  });

  it('waits for a sweep still holding the lock, so its late unlink cannot win', () => {
    const d = dir();
    const { path } = spillPayload(text, { dir: d, retentionDays: 0 });
    const lock = join(d, '.sweep.lock');
    writeFileSync(lock, '999999');
    // The re-spill sees the lock; only on its next look does the sweep delete the file
    // (judged expired before the rename) and finish. Repairing without waiting would
    // check too early and lose the file.
    between.hooks.push({
      fn: 'statSync',
      match: (p) => p === lock,
      action: () =>
        between.hooks.push({
          fn: 'statSync',
          match: (p) => p === lock,
          action: () => {
            unlinkSync(path);
            finishOtherSweep(d);
          },
        }),
    });

    spillPayload(text, { dir: d, retentionDays: 0 });

    expect(between.hooks).toHaveLength(0);
    expect(readFileSync(path, 'utf8')).toBe(text);
  });

  it('lets only one of two processes sweep in the same interval', () => {
    const d = dir();
    const now = Date.now();
    const old = spillPayload(`old\n${'x'.repeat(2000)}`, { dir: d, retentionDays: 0 }).path;
    age(old, 20 * DAY);
    // An earlier sweep ran two hours ago, so both processes see the interval as expired.
    writeFileSync(join(d, '.last-prune'), `${now - 2 * PRUNE_INTERVAL_MS} 1.a\n`);
    between.readdirs = 0;
    let second = -1;
    between.hooks.push({ fn: 'statSync', match: (p) => p === old, action: () => (second = maybePruneSpill(d, 14, now)) });
    const first = maybePruneSpill(d, 14, now);

    expect(first + second).toBe(1);
    expect(between.readdirs).toBe(1);
    expect(existsSync(old)).toBe(false);
  });

  it('takes over the lock of a sweeper that died mid-sweep', () => {
    const d = dir();
    const old = spillPayload(`old\n${'x'.repeat(2000)}`, { dir: d, retentionDays: 0 }).path;
    age(old, 20 * DAY);
    writeFileSync(join(d, '.sweep.lock'), '999999');
    age(join(d, '.sweep.lock'), 10 * 60 * 1000);

    expect(maybePruneSpill(d, 14)).toBe(1);
    expect(existsSync(join(d, '.sweep.lock'))).toBe(false);
  });
});
