import { describe, expect, it } from 'vitest';
import { jevCompaction } from '../src/hook.js';
import type { OmpMessage } from '../src/map.js';
import { compact } from '../src/vendor/fast-jev/compact.js';
import { collectToolCalls, fitState } from '../src/vendor/fast-jev/state.js';
import type { JevAsker, JevQuestions, JevState, Message } from '../src/vendor/fast-jev/types.js';

const LIMIT = 25_000;

function asker(noul: number): JevAsker & { calls: number; asked: string[] } {
  return {
    calls: 0,
    asked: [],
    async ask(_state: JevState, questions: JevQuestions) {
      this.calls += 1;
      const answers: Record<string, { type: 'noul'; noul: number }> = {};
      for (const name of Object.keys(questions)) {
        this.asked.push(name);
        answers[name] = { type: 'noul', noul };
      }
      return { answers };
    },
  };
}

/**
 * A history whose Jev state cannot fit at 25k tokens: every stage of shrinking
 * still leaves one line per call, so enough calls overflow the budget. 400
 * turns reproduce the live failure shape ("~32889 tokens after truncation").
 */
function oversized(turns: number): Message[] {
  const messages: Message[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push({ role: 'user', text: `step ${turn}: ${'reason '.repeat(20)}`, toolUses: [] });
    messages.push({
      role: 'assistant',
      text: `calling read for step ${turn}`,
      toolUses: [
        {
          tool_use_id: `u-${turn}`,
          tool: 'read',
          input: { path: `/repo/module-${turn}/${'segment/'.repeat(40)}file.ts` },
        },
      ],
    });
    messages.push({
      role: 'user',
      text: '',
      toolUses: [],
      toolResults: [{ tool_use_id: `u-${turn}`, text: `contents ${turn}: ${'payload '.repeat(100)}` }],
    });
  }
  return messages;
}

function ompTranscript(turns: number): OmpMessage[] {
  const messages: OmpMessage[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push({ role: 'user', content: `step ${turn}: ${'reason '.repeat(60)}` });
    messages.push({
      role: 'assistant',
      content: [
        { type: 'text', text: `calling read for step ${turn}: ${'because '.repeat(40)}` },
        {
          type: 'toolCall',
          id: `call-${turn}`,
          name: 'read',
          arguments: { path: `/repo/module-${turn}/${'segment/'.repeat(90)}file.ts` },
        },
      ],
    });
    messages.push({
      role: 'toolResult',
      toolCallId: `call-${turn}`,
      toolName: 'read',
      content: [{ type: 'text', text: `contents of file ${turn}: ${'payload '.repeat(300)}` }],
    });
  }
  return messages;
}
describe('state fitting under an oversized history', () => {
  it('leaves old entries out instead of failing the request', () => {
    const messages = oversized(400);
    const calls = collectToolCalls(messages, 6);
    const fitted = fitState(messages, calls, {
      maxStateTokens: LIMIT,
      preserveRecentMessages: 6,
      goal: 'finish the refactor',
    });
    expect(fitted.tokens).toBeLessThanOrEqual(LIMIT);
    expect(fitted.stage).toBe('old entries left out');
    expect(fitted.representedCalls.size).toBeGreaterThan(0);
    expect(fitted.representedCalls.size).toBeLessThan(calls.length);
  });

  it('keeps the newest calls in the state and leaves the oldest out', () => {
    const messages = oversized(400);
    const calls = collectToolCalls(messages, 6);
    const fitted = fitState(messages, calls, {
      maxStateTokens: LIMIT,
      preserveRecentMessages: 6,
      goal: '',
    });
    expect(fitted.representedCalls.has(calls.at(-1)!.id)).toBe(true);
    expect(fitted.representedCalls.has(calls[0]!.id)).toBe(false);
  });
});

describe('compaction of a history Jev cannot hold at once', () => {
  it('asks only about calls the state still shows and counts the rest unscored', async () => {
    const jev = asker(0.05);
    const result = await compact(oversized(400), jev, { keepThreshold: 0.2, goal: 'refactor' });
    expect(result.stats.unscored).toBeGreaterThan(0);
    expect(result.stats.calls).toBe(400);
    // Two questions per call: `call_<id>` and `result_<id>`.
    const asked = new Set(jev.asked.map((name) => name.replace(/^(call|result)_/, '')));
    expect(asked.size).toBe(result.stats.calls - result.stats.unscored - result.stats.pinned);
    // An unscored call keeps its output: nothing is dropped on a blind guess.
    const dropped = result.decisions.filter((decision) => decision.action !== 'keep');
    expect(dropped.length).toBeGreaterThan(0);
    for (const decision of dropped) expect(asked.has(decision.id)).toBe(true);
  });
});

describe('the compaction hook on a region larger than one Jev window', () => {
  it('scores a region no single Jev state can hold, in windows', async () => {
    const jev = asker(0.05);
    const outcome = await jevCompaction(
      {
        firstKeptEntryId: 'entry-1',
        messagesToSummarize: ompTranscript(400),
        turnPrefixMessages: [],
        tokensBefore: 400_000,
      },
      jev,
      { goal: 'ship the fix' },
    );
    expect(outcome.skipped).toBeUndefined();
    expect(outcome.reduction).toBeGreaterThan(0.2);
    expect(outcome.result?.stats.requests).toBeGreaterThan(1);
    // Windowing scores every call, so nothing falls back to blind keeping.
    expect(outcome.result?.stats.unscored).toBe(0);
    expect(outcome.result?.stats.calls).toBe(400);
    expect(outcome.compaction?.summary).toContain('read');
  });

  it('keeps decision ids unique across windows', async () => {
    const jev = asker(0.05);
    const outcome = await jevCompaction(
      {
        firstKeptEntryId: 'entry-1',
        messagesToSummarize: ompTranscript(90),
        turnPrefixMessages: [],
        tokensBefore: 400_000,
      },
      jev,
      { goal: 'ship the fix' },
    );
    const ids = outcome.result!.decisions.map((decision) => decision.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('reports nothing to do for an empty region', async () => {
    const outcome = await jevCompaction(
      {
        firstKeptEntryId: 'entry-1',
        messagesToSummarize: [],
        turnPrefixMessages: [],
        tokensBefore: 0,
      },
      asker(0.05),
      {},
    );
    expect(outcome.skipped).toBe('no-tool-calls');
  });
});
