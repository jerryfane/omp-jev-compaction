import { describe, expect, it } from 'vitest';
import { jevCompaction, settingsFromEnv } from '../src/hook.js';
import type { OmpMessage } from '../src/map.js';
import { decideCall } from '../src/vendor/fast-jev/compact.js';
import type { JevAsker, JevQuestions, JevState } from '../src/vendor/fast-jev/types.js';

const floorAsker = (noul: number): JevAsker => ({
  async ask(_state: JevState, questions: JevQuestions) {
    const answers: Record<string, { type: 'noul'; noul: number }> = {};
    for (const name of Object.keys(questions)) answers[name] = { type: 'noul', noul };
    return { answers };
  },
});

function transcript(): OmpMessage[] {
  return [
    { role: 'user', content: 'check the config' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'running the check' },
        { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'grep port config.json' } },
      ],
    },
    { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: 'P'.repeat(9000) }] },
    { role: 'user', content: 'thanks' },
  ];
}

describe('never erasing the call record', () => {
  it('degrades a would-be call drop to an output drop by default', () => {
    const decision = decideCall({ id: 't1', tool: 'bash', pinned: false }, { keepCall: 0.01, keepResult: 0.01 }, {
      keepThreshold: 0.9,
    });
    expect(decision.action).toBe('drop_result');
    expect(decision.reason).toBe('result_dropped');
  });

  it('still allows dropping the call when explicitly opted in', () => {
    const decision = decideCall(
      { id: 't1', tool: 'bash', pinned: false },
      { keepCall: 0.01, keepResult: 0.01 },
      { keepThreshold: 0.9, allowDroppingCalls: true },
    );
    expect(decision.action).toBe('drop_call');
  });

  it('keeps the call visible in the rendered history even at a brutal threshold', async () => {
    const outcome = await jevCompaction(
      { firstKeptEntryId: 'e1', messagesToSummarize: transcript(), turnPrefixMessages: [], tokensBefore: 50_000 },
      floorAsker(0.01),
      { keepThreshold: 0.95, preserveRecentMessages: 0, minReductionRatio: 0.05 },
    );
    expect(outcome.compaction).toBeDefined();
    const summary = outcome.compaction!.summary;
    // The command and its id survive; only the payload goes.
    expect(summary).toContain('Tool call: bash (c1)');
    expect(summary).toContain('grep port config.json');
    expect(summary).not.toContain('P'.repeat(400));
    expect(outcome.result!.stats.callsDropped).toBe(0);
    expect(outcome.result!.stats.resultsDropped).toBe(1);
  });

  it('reads the opt-in from the environment', () => {
    expect(settingsFromEnv({}).allowDroppingCalls).toBe(false);
    expect(settingsFromEnv({ OMP_JEV_ALLOW_DROPPING_CALLS: '1' }).allowDroppingCalls).toBe(true);
  });
});
