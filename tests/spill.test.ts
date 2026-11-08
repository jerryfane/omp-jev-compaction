import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
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
  const age = (path: string, days: number, now: number) => {
    const t = (now - days * DAY) / 1000;
    utimesSync(path, t, t);
  };

  it('deletes spill files past the retention age and keeps newer ones', () => {
    const d = dir();
    const now = Date.now();
    const old = spillPayload(`old\n${'x'.repeat(2000)}`, { dir: d, retentionDays: 0 }).path;
    const fresh = spillPayload(`fresh\n${'y'.repeat(2000)}`, { dir: d, retentionDays: 0 }).path;
    age(old, 15, now);
    age(fresh, 13, now);
    expect(pruneSpill(d, 14 * DAY, now)).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('only ever deletes its own <hash>.txt files', () => {
    const d = dir();
    const now = Date.now();
    const other = join(d, 'notes.txt');
    writeFileSync(other, 'not ours');
    age(other, 100, now);
    expect(pruneSpill(d, 14 * DAY, now)).toBe(0);
    expect(existsSync(other)).toBe(true);
  });

  it('sweeps on spill, at most once per interval of elapsed time', () => {
    const d = dir();
    // One millisecond before an hour boundary: the interval is elapsed time, not the clock hour.
    const now = Math.floor(Date.now() / PRUNE_INTERVAL_MS) * PRUNE_INTERVAL_MS - 1;
    const old = spillPayload(`old\n${'x'.repeat(2000)}`, { dir: d, retentionDays: 0 }).path;
    age(old, 20, now);
    expect(maybePruneSpill(d, 14, now)).toBe(1);

    const again = spillPayload(`again\n${'z'.repeat(2000)}`, { dir: d, retentionDays: 0 }).path;
    age(again, 20, now);
    // Across the hour boundary but within the interval: no second sweep, the old file stays.
    expect(maybePruneSpill(d, 14, now + 2)).toBe(0);
    expect(maybePruneSpill(d, 14, now + PRUNE_INTERVAL_MS - 1)).toBe(0);
    expect(existsSync(again)).toBe(true);
    expect(maybePruneSpill(d, 14, now + PRUNE_INTERVAL_MS)).toBe(1);
  });

  it('keeps everything when retention is 0', () => {
    const d = dir();
    const now = Date.now();
    const old = spillPayload(`old\n${'x'.repeat(2000)}`, { dir: d, retentionDays: 0 }).path;
    age(old, 400, now);
    expect(maybePruneSpill(d, 0, now)).toBe(0);
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
