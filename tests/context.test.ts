import { describe, expect, it } from 'vitest';
import { CachingAsker, createContextReducer, rewriteOmpMessages } from '../src/context.js';
import type { OmpMessage } from '../src/map.js';
import type { JevAnswer, JevAsker, JevQuestions, JevState } from '../src/vendor/fast-jev/types.js';

function countingAsker(overrides: Record<string, number> = {}, fallback = 0.9) {
  const asker: JevAsker & { calls: number; asked: string[] } = {
    calls: 0,
    asked: [],
    async ask(_state: JevState, questions: JevQuestions) {
      asker.calls += 1;
      const answers: Record<string, JevAnswer> = {};
      for (const name of Object.keys(questions)) {
        asker.asked.push(name);
        answers[name] = { type: 'noul', noul: overrides[name] ?? fallback };
      }
      return { answers };
    },
  };
  return asker;
}

function bigTranscript(size = 30_000): OmpMessage[] {
  return [
    { role: 'user', content: 'read the log and find the failing test' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'reading' },
        { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'test.log' } },
      ],
    },
    { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: 'L'.repeat(size) }] },
    { role: 'assistant', content: [{ type: 'text', text: 'the failing test is parsePort' }] },
    { role: 'user', content: 'fix it' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'editing' },
        { type: 'toolCall', id: 'c2', name: 'edit', arguments: { path: 'src/config.ts' } },
      ],
    },
    { role: 'toolResult', toolCallId: 'c2', toolName: 'edit', content: [{ type: 'text', text: 'edited 1 line' }] },
  ];
}

describe('context reducer', () => {
  it('leaves a small context untouched without asking anything', async () => {
    const asker = countingAsker();
    const reduce = createContextReducer(asker, { minChars: 1_000_000 });
    expect(await reduce(bigTranscript())).toBeUndefined();
    expect(asker.calls).toBe(0);
  });

  it('drops a stale result and keeps every other message object by reference', async () => {
    const asker = countingAsker({ result_t1: 0.05 });
    const source = bigTranscript();
    const reduce = createContextReducer(asker, { minChars: 1000, preserveRecentMessages: 1 });
    const out = await reduce(source);
    expect(out).toBeDefined();

    const droppedResult = out!.find((m) => (m as { toolCallId?: string }).toolCallId === 'c1') as {
      content: { text: string }[];
    };
    // A dropped result keeps a short head plus a pointer to the parked payload.
    expect(droppedResult.content[0].text.length).toBeLessThan(700);
    expect(droppedResult.content[0].text).toMatch(/read \S+\.txt/);
    expect(out![0]).toBe(source[0]);
    expect(out![3]).toBe(source[3]);
    expect(out!.length).toBe(source.length);
  });

  it('returns undefined when Jev keeps everything', async () => {
    const reduce = createContextReducer(countingAsker({}, 0.99), { minChars: 1000, preserveRecentMessages: 1 });
    expect(await reduce(bigTranscript())).toBeUndefined();
  });

  it('does not reuse answers for the same local call id in different windows', async () => {
    const asker: JevAsker & { calls: number } = {
      calls: 0,
      async ask(state: JevState, questions: JevQuestions) {
        asker.calls += 1;
        const keep = JSON.stringify(state).includes('second.txt') ? 0.99 : 0.01;
        return {
          answers: Object.fromEntries(
            Object.keys(questions).map((name) => [name, { type: 'noul' as const, noul: keep }]),
          ),
        };
      },
    };
    const source: OmpMessage[] = [
      { role: 'user', content: 'compare two files' },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'first', name: 'read', arguments: { path: 'first.txt' } }],
      },
      {
        role: 'toolResult',
        toolCallId: 'first',
        toolName: 'read',
        content: [{ type: 'text', text: 'A'.repeat(2_000) }],
      },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'second', name: 'read', arguments: { path: 'second.txt' } }],
      },
      {
        role: 'toolResult',
        toolCallId: 'second',
        toolName: 'read',
        content: [{ type: 'text', text: 'B'.repeat(2_000) }],
      },
    ];

    const reduce = createContextReducer(new CachingAsker(asker), {
      minChars: 1,
      maxWindowChars: 1_000,
      preserveRecentMessages: 0,
      spill: { enabled: false },
    });
    const out = await reduce(source);

    expect(asker.calls).toBe(2);
    const first = out!.find((message) => (message as { toolCallId?: string }).toolCallId === 'first') as {
      content: { text: string }[];
    };
    const second = out!.find((message) => (message as { toolCallId?: string }).toolCallId === 'second') as {
      content: { text: string }[];
    };
    expect(first.content[0].text).toContain('[fast-jev-compaction truncated');
    expect(second.content[0].text).toBe('B'.repeat(2_000));
  });

  it('asks once and then reuses the decisions without asking again', async () => {
    const asker = countingAsker({ result_t1: 0.05 });
    const reduce = createContextReducer(new CachingAsker(asker), { minChars: 1000, preserveRecentMessages: 1 });
    const first = await reduce(bigTranscript());
    const asksAfterFirst = asker.calls;
    expect(asksAfterFirst).toBeGreaterThan(0);
    const second = await reduce(bigTranscript());
    expect(asker.calls).toBe(asksAfterFirst);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe('rewriteOmpMessages', () => {
  it('keeps a tiny dropped payload inline, since parking it would save nothing', () => {
    const source: OmpMessage[] = [
      { role: 'toolResult', toolCallId: 'gone', toolName: 'read', content: [{ type: 'text', text: 'payload' }] },
    ];
    const out = rewriteOmpMessages(source, [{ toolUses: [], toolResults: [] }]);
    expect((out[0] as { content: { text: string }[] }).content[0].text).toContain('payload');
  });

  it('parks a large dropped payload and points at the file', () => {
    const big = 'E'.repeat(5000);
    const source: OmpMessage[] = [
      { role: 'toolResult', toolCallId: 'gone', toolName: 'read', content: [{ type: 'text', text: big }] },
    ];
    const out = rewriteOmpMessages(source, [{ toolUses: [], toolResults: [] }]);
    const text = (out[0] as { content: { text: string }[] }).content[0].text;
    expect(text).toMatch(/read \S+\.txt/);
    expect(text.length).toBeLessThan(big.length);
  });

  it('passes an unchanged result through untouched', () => {
    const source: OmpMessage[] = [
      { role: 'toolResult', toolCallId: 'keep', toolName: 'read', content: [{ type: 'text', text: 'payload' }] },
    ];
    const out = rewriteOmpMessages(source, [
      { toolUses: [{ tool_use_id: 'keep' }], toolResults: [{ tool_use_id: 'keep', text: 'payload' }] },
    ]);
    expect(out[0]).toBe(source[0]);
  });
});
