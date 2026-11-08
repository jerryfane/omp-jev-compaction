import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rewriteOmpMessages } from '../src/context.js';
import type { OmpMessage } from '../src/map.js';
import { isSpillNotice, maybePruneSpill, PRUNE_INTERVAL_MS, pruneSpill, spillPayload } from '../src/spill.js';

const dir = () => mkdtempSync(join(tmpdir(), 'jev-spill-test-'));

describe('spillPayload', () => {
  it('writes the payload and names the file in the notice', () => {
    const d = dir();
    const payload = `port=8471\n${'noise\n'.repeat(500)}`;
    const spilled = spillPayload(payload, { dir: d });
    expect(readFileSync(spilled.path, 'utf8')).toBe(payload);
    expect(spilled.notice).toContain(`read ${spilled.path}`);
    expect(spilled.notice).toContain('port=8471'); // head kept inline
    expect(spilled.notice.length).toBeLessThan(payload.length);
  });

  it('collapses identical payloads onto one file', () => {
    const d = dir();
    const a = spillPayload('same output', { dir: d });
    const b = spillPayload('same output', { dir: d });
    expect(b.path).toBe(a.path);
  });

  it('recognises its own notice so a second pass does not spill a pointer', () => {
    const d = dir();
    const notice = spillPayload('x'.repeat(2000), { dir: d }).notice;
    expect(isSpillNotice(notice)).toBe(true);
    expect(isSpillNotice('ordinary tool output')).toBe(false);
  });
});

describe('spill retention', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.parse('2026-11-20T12:00:00Z');
  /** A spill file in the day folder `day`, as an earlier spill would have left it. */
  const spilled = (d: string, day: string, name = '0123456789abcdef.txt') => {
    mkdirSync(join(d, day), { recursive: true });
    writeFileSync(join(d, day, name), 'payload');
    return join(d, day, name);
  };
  const age = (path: string, days: number, now: number) => {
    const t = (now - days * DAY) / 1000;
    utimesSync(path, t, t);
  };

  it('writes into a folder for the current UTC day', () => {
    const d = dir();
    const { path } = spillPayload(`p\n${'x'.repeat(2000)}`, { dir: d, retentionDays: 0 });
    expect(path.startsWith(join(d, new Date().toISOString().slice(0, 10)))).toBe(true);
  });

  it('deletes a day folder once the end of that day is past retention, and no sooner', () => {
    const d = dir();
    // 2026-11-05 ended 14.5 days before NOW; 2026-11-06 ended 13.5 days before.
    const expired = spilled(d, '2026-11-05');
    spilled(d, '2026-11-05', 'fedcba9876543210.txt');
    const kept = spilled(d, '2026-11-06');
    expect(pruneSpill(d, 14 * DAY, NOW)).toBe(2);
    expect(existsSync(join(d, '2026-11-05'))).toBe(false);
    expect(existsSync(expired)).toBe(false);
    expect(existsSync(kept)).toBe(true);
  });

  it('deletes pre-0.2.0 flat spill files by age', () => {
    const d = dir();
    const old = join(d, '0123456789abcdef.txt');
    const fresh = join(d, 'fedcba9876543210.txt');
    writeFileSync(old, 'old');
    writeFileSync(fresh, 'fresh');
    age(old, 15, NOW);
    age(fresh, 13, NOW);
    expect(pruneSpill(d, 14 * DAY, NOW)).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('only ever deletes its own day folders and <hash>.txt files', () => {
    const d = dir();
    const other = join(d, 'notes.txt');
    writeFileSync(other, 'not ours');
    age(other, 100, NOW);
    mkdirSync(join(d, 'archive'));
    expect(pruneSpill(d, 14 * DAY, NOW)).toBe(0);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(join(d, 'archive'))).toBe(true);
  });

  it('sweeps on spill, at most once per interval of elapsed time', () => {
    const d = dir();
    // One millisecond before an hour boundary: the interval is elapsed time, not the clock hour.
    const now = Math.floor(NOW / PRUNE_INTERVAL_MS) * PRUNE_INTERVAL_MS - 1;
    spilled(d, '2026-11-01');
    expect(maybePruneSpill(d, 14, now)).toBe(1);

    const again = spilled(d, '2026-11-02');
    // Across the hour boundary but within the interval: no second sweep, the old file stays.
    expect(maybePruneSpill(d, 14, now + 2)).toBe(0);
    expect(maybePruneSpill(d, 14, now + PRUNE_INTERVAL_MS - 1)).toBe(0);
    expect(existsSync(again)).toBe(true);
    expect(maybePruneSpill(d, 14, now + PRUNE_INTERVAL_MS)).toBe(1);
  });

  it('keeps everything when retention is 0', () => {
    const d = dir();
    const old = spilled(d, '2025-01-01');
    expect(maybePruneSpill(d, 0, NOW)).toBe(0);
    expect(existsSync(old)).toBe(true);
  });
});

describe('rewriteOmpMessages with recovery', () => {
  const source = (text: string): OmpMessage[] => [
    { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text }] },
  ];

  it('makes a dropped payload readable again', () => {
    const d = dir();
    const payload = `the error code is PG-42703\n${'filler\n'.repeat(400)}`;
    const out = rewriteOmpMessages(source(payload), [{ toolUses: [], toolResults: [] }], { dir: d });
    const text = (out[0] as { content: { text: string }[] }).content[0].text;
    const path = text.match(/read (\S+\.txt)/)?.[1];
    expect(path).toBeDefined();
    // The fact that reduction removed is still retrievable, byte for byte.
    expect(readFileSync(path!, 'utf8')).toBe(payload);
    expect(readFileSync(path!, 'utf8')).toContain('PG-42703');
  });

  it('falls back to a plain note when spilling is switched off', () => {
    const out = rewriteOmpMessages(source('payload'), [{ toolUses: [], toolResults: [] }], { enabled: false });
    const text = (out[0] as { content: { text: string }[] }).content[0].text;
    expect(text).toContain('re-run the tool');
    expect(text).not.toContain('read /');
  });

  it('leaves an untouched result exactly as omp built it', () => {
    const d = dir();
    const messages = source('kept output');
    const out = rewriteOmpMessages(messages, [
      { toolUses: [{ tool_use_id: 'c1' }], toolResults: [{ tool_use_id: 'c1', text: 'kept output' }] },
    ], { dir: d });
    expect(out[0]).toBe(messages[0]);
  });
});
