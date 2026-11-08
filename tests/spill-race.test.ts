import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import type * as Fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { pruneSpill, spillPayload } from '../src/spill.js';

/**
 * Another omp process acting between two filesystem calls of the sweeper, made
 * deterministic: the queued action runs once, right after the first `statSync` or
 * `readdirSync` of a matching path returns, i.e. after the sweeper has looked at an
 * expired copy and before it deletes it. vi.mock is hoisted above the imports, so
 * src/spill.ts sees these wrappers.
 */
const between = vi.hoisted(() => ({
  match: (_path: string) => false,
  action: undefined as undefined | (() => void),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  const after = (path: Fs.PathLike) => {
    const action = between.action;
    if (action && between.match(String(path))) {
      between.action = undefined;
      action();
    }
  };
  return {
    ...actual,
    statSync: ((path: Fs.PathLike, ...rest: unknown[]) => {
      const result = (actual.statSync as (...a: unknown[]) => unknown)(path, ...rest);
      after(path);
      return result;
    }) as typeof actual.statSync,
    readdirSync: ((path: Fs.PathLike, ...rest: unknown[]) => {
      const result = (actual.readdirSync as (...a: unknown[]) => unknown)(path, ...rest);
      after(path);
      return result;
    }) as typeof actual.readdirSync,
  };
});

const DAY = 24 * 60 * 60 * 1000;

describe('spill pruning under concurrent processes', () => {
  it('keeps a payload re-spilled while a sweep is deleting its expired copy', () => {
    const d = mkdtempSync(join(tmpdir(), 'jev-spill-race-'));
    const now = Date.now();
    const text = `payload\n${'x'.repeat(2000)}`;
    const name = `${createHash('sha256').update(text).digest('hex').slice(0, 16)}.txt`;
    // An expired copy, in both the day-folder and the pre-0.2.0 flat layout.
    const oldDay = new Date(now - 20 * DAY).toISOString().slice(0, 10);
    const expired = [join(d, oldDay, name), join(d, name)];
    mkdirSync(join(d, oldDay));
    for (const path of expired) {
      writeFileSync(path, text);
      const t = (now - 20 * DAY) / 1000;
      utimesSync(path, t, t);
    }

    // The sweeper has judged an expired copy; before it deletes, another process re-spills.
    let returned = '';
    between.match = (p) => p === join(d, oldDay) || p === join(d, name);
    between.action = () => {
      returned = spillPayload(text, { dir: d, retentionDays: 0 }).path;
    };
    pruneSpill(d, 14 * DAY, now);

    expect(between.action).toBeUndefined();
    expect(existsSync(returned)).toBe(true);
    expect(readFileSync(returned, 'utf8')).toBe(text);
  });
});
