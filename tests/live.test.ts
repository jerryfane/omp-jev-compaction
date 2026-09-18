import { describe, expect, it } from 'vitest';
import { DualJevClient } from '../src/asker.js';
import { jevCompaction } from '../src/hook.js';
import type { OmpMessage } from '../src/map.js';

/**
 * Hits the real decision endpoint. Skipped unless JEV_LIVE=1 so CI and the
 * normal suite stay offline and deterministic.
 */
const live = process.env.JEV_LIVE === '1';
const suite = live ? describe : describe.skip;

/**
 * A transcript where the answer is knowable: the file was read, the fix landed
 * and the tests passed, so the 40k-char read output is no longer load-bearing
 * while the user's instruction still is.
 */
function staleReadTranscript(): OmpMessage[] {
  return [
    { role: 'user', content: 'Fix the off-by-one in parsePort in src/config.ts, then run the tests.' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Reading the file first.' },
        { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'src/config.ts' } },
      ],
    },
    {
      role: 'toolResult',
      toolCallId: 'c1',
      toolName: 'read',
      content: [{ type: 'text', text: `export function parsePort(raw: string) {\n${'  // filler\n'.repeat(3000)}}` }],
    },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Found it, the slice ended one character early. Applying the fix.' },
        { type: 'toolCall', id: 'c2', name: 'edit', arguments: { path: 'src/config.ts', line: 12 } },
      ],
    },
    { role: 'toolResult', toolCallId: 'c2', toolName: 'edit', content: [{ type: 'text', text: 'edited 1 line' }] },
    { role: 'user', content: 'Tests pass now. Next, add the changelog entry.' },
  ];
}

suite('live Jev decisions', () => {
  it('answers with noul probabilities over OpenRouter', async () => {
    const client = new DualJevClient({ provider: 'openrouter' });
    const response = await client.ask(
      {
        context: 'omp coding session',
        goal: 'decide whether an old tool result is still needed',
        history: [
          { i: 0, role: 'user', text: 'read src/config.ts and fix parsePort' },
          {
            i: 1,
            role: 'assistant',
            text: 'reading',
            tool_calls: [{ id: 't1', tool: 'read', input: '{"path":"src/config.ts"}', result: 'ok, 40000 chars (omitted)' }],
          },
          { i: 2, role: 'user', text: 'the fix landed and tests pass' },
        ],
      },
      {
        call_t1: { type: 'noul', instructions: 'Tool call t1 (read) should stay in the history' },
        result_t1: { type: 'noul', instructions: 'The full output of tool call t1 should stay in the history verbatim' },
      },
    );
    expect(response.answers.call_t1.noul).toBeGreaterThanOrEqual(0);
    expect(response.answers.call_t1.noul).toBeLessThanOrEqual(1);
    expect(response.answers.result_t1.noul).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it('drops the superseded read and keeps every word of user text', async () => {
    const client = new DualJevClient({ provider: 'openrouter' });
    const outcome = await jevCompaction(
      {
        firstKeptEntryId: 'entry-live',
        messagesToSummarize: staleReadTranscript(),
        turnPrefixMessages: [],
        tokensBefore: 90_000,
      },
      client,
      { preserveRecentMessages: 1, minReductionRatio: 0.1 },
    );

    expect(outcome.compaction, `no compaction: ${outcome.skipped} (reduction ${outcome.reduction})`).toBeDefined();
    const summary = outcome.compaction!.summary;
    expect(summary).toContain('Fix the off-by-one in parsePort in src/config.ts, then run the tests.');
    expect(summary).toContain('Tests pass now. Next, add the changelog entry.');
    expect(summary).toContain('the slice ended one character early');
    expect(summary).not.toContain('// filler\n'.repeat(100));
    expect(outcome.reduction).toBeGreaterThan(0.5);
  }, 60_000);
});
