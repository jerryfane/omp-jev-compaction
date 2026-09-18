import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rewriteOmpMessages } from '../src/context.js';
import type { OmpMessage } from '../src/map.js';
import { isSpillNotice, spillPayload } from '../src/spill.js';

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
