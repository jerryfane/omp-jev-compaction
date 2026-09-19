import { describe, expect, it } from 'vitest';
import { CachingAsker } from '../src/context.js';
import { compact } from '../src/vendor/fast-jev/compact.js';
import { collectToolCalls } from '../src/vendor/fast-jev/state.js';
import type {
  JevAsker,
  JevCacheKeys,
  JevQuestions,
  JevState,
  Message,
} from '../src/vendor/fast-jev/types.js';

const questions: JevQuestions = {
  call_t1: { type: 'noul', instructions: 'Is this call relevant?' },
};

function state(text: string, goal = 'ship safely'): JevState {
  return {
    context: 'coding assistant conversation',
    goal,
    history: [{ index: 0, role: 'assistant', text }],
  };
}

function changingAsker(): JevAsker & { calls: number } {
  return {
    calls: 0,
    async ask(_state, asked) {
      this.calls += 1;
      const noul = this.calls === 1 ? 0.05 : 0.95;
      return {
        answers: Object.fromEntries(
          Object.keys(asked).map((name) => [name, { type: 'noul' as const, noul }]),
        ),
      };
    },
  };
}

function transcript(resultText: string): Message[] {
  return [
    { role: 'user', text: 'check deployment', toolUses: [] },
    {
      role: 'assistant',
      text: 'reading deploy output',
      toolUses: [
        {
          tool_use_id: 'original-call-id',
          tool: 'read',
          input: { path: '/deploy/result.txt' },
        },
      ],
    },
    {
      role: 'user',
      text: '',
      toolUses: [],
      toolResults: [{ tool_use_id: 'original-call-id', text: resultText }],
    },
    { role: 'assistant', text: 'continuing', toolUses: [] },
  ];
}

describe('CachingAsker identity', () => {
  it('reuses the same question only for the same state and content identity', async () => {
    const inner = changingAsker();
    const cached = new CachingAsker(inner);
    const keys: JevCacheKeys = { call_t1: 'content-a:call' };

    const first = await cached.ask(state('same state'), questions, keys);
    const second = await cached.ask(state('same state'), questions, keys);

    expect(first.answers.call_t1).toMatchObject({ noul: 0.05 });
    expect(second.answers.call_t1).toMatchObject({ noul: 0.05 });
    expect(inner.calls).toBe(1);
    expect(cached.answered).toBe(1);
  });

  it('does not reuse call_t1 for an unrelated state', async () => {
    const inner = changingAsker();
    const cached = new CachingAsker(inner);

    const first = await cached.ask(state('directory listing'), questions, {
      call_t1: 'listing:call',
    });
    const second = await cached.ask(state('deployment result'), questions, {
      call_t1: 'deployment:call',
    });

    expect(first.answers.call_t1).toMatchObject({ noul: 0.05 });
    expect(second.answers.call_t1).toMatchObject({ noul: 0.95 });
    expect(inner.calls).toBe(2);
    expect(cached.answered).toBe(0);
  });

  it('invalidates cached answers when the goal changes', async () => {
    const inner = changingAsker();
    const cached = new CachingAsker(inner);

    await cached.ask(state('same history', 'inspect logs'), questions, { call_t1: 'same:call' });
    const changed = await cached.ask(state('same history', 'deploy release'), questions, {
      call_t1: 'same:call',
    });

    expect(changed.answers.call_t1).toMatchObject({ noul: 0.95 });
    expect(inner.calls).toBe(2);
  });

  it('distinguishes changed result text even when its length and state shape match', async () => {
    const firstMessages = transcript('service port 8471');
    const secondMessages = transcript('service port 9471');
    const firstCall = collectToolCalls(firstMessages, 0)[0]!;
    const secondCall = collectToolCalls(secondMessages, 0)[0]!;
    expect(firstCall.resultChars).toBe(secondCall.resultChars);
    expect(firstCall.cacheKey).not.toBe(secondCall.cacheKey);

    const inner = changingAsker();
    const cached = new CachingAsker(inner);
    const first = await compact(firstMessages, cached, {
      keepThreshold: 0.2,
      preserveRecentMessages: 0,
    });
    const second = await compact(secondMessages, cached, {
      keepThreshold: 0.2,
      preserveRecentMessages: 0,
    });

    expect(first.decisions[0]?.action).toBe('drop_result');
    expect(second.decisions[0]?.action).toBe('keep');
    expect(inner.calls).toBe(2);
    expect(cached.answered).toBe(0);
  });
});
