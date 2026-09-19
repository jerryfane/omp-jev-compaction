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

  it('keeps state identities separate when asks overlap', async () => {
    let calls = 0;
    let releaseA: ((answer: { answers: { call_t1: { type: 'noul'; noul: number } } }) => void) | undefined;
    const answerA = new Promise<{ answers: { call_t1: { type: 'noul'; noul: number } } }>(
      (resolve) => {
        releaseA = resolve;
      },
    );
    const inner: JevAsker = {
      async ask(current) {
        calls += 1;
        if (current.goal === 'state A') return answerA;
        return { answers: { call_t1: { type: 'noul', noul: 0.95 } } };
      },
    };
    const cached = new CachingAsker(inner);
    const keys = { call_t1: 'same-content:call' };

    const pendingA = cached.ask(state('same history', 'state A'), questions, keys);
    const firstB = await cached.ask(state('same history', 'state B'), questions, keys);
    releaseA?.({ answers: { call_t1: { type: 'noul', noul: 0.05 } } });
    await pendingA;
    const secondB = await cached.ask(state('same history', 'state B'), questions, keys);

    expect(firstB.answers.call_t1).toMatchObject({ noul: 0.95 });
    expect(secondB.answers.call_t1).toMatchObject({ noul: 0.95 });
    expect(calls).toBe(2);
    expect(cached.answered).toBe(1);
  });

  it('reuses an exact state after another state is evaluated', async () => {
    const inner = changingAsker();
    const cached = new CachingAsker(inner);
    const keys = { call_t1: 'same-content:call' };

    const firstA = await cached.ask(state('history A'), questions, keys);
    await cached.ask(state('history B'), questions, keys);
    const secondA = await cached.ask(state('history A'), questions, keys);

    expect(firstA.answers.call_t1).toMatchObject({ noul: 0.05 });
    expect(secondA.answers.call_t1).toMatchObject({ noul: 0.05 });
    expect(inner.calls).toBe(2);
    expect(cached.answered).toBe(1);
  });

  it('bypasses caching when an adapter supplies a non-serializable state', async () => {
    const inner = changingAsker();
    const cached = new CachingAsker(inner);
    const circular = state('circular') as JevState & { self?: unknown };
    circular.self = circular;

    await cached.ask(circular, questions, { call_t1: 'content:call' });
    await cached.ask(circular, questions, { call_t1: 'content:call' });

    expect(inner.calls).toBe(2);
    expect(cached.cache.size).toBe(0);
  });

  it('bounds retained state entries with LRU eviction', async () => {
    const inner = changingAsker();
    const cached = new CachingAsker(inner, 2);
    const keys = { call_t1: 'same-content:call' };

    await cached.ask(state('history A'), questions, keys);
    await cached.ask(state('history B'), questions, keys);
    await cached.ask(state('history C'), questions, keys);
    expect(cached.cache.size).toBe(2);

    await cached.ask(state('history A'), questions, keys);
    expect(inner.calls).toBe(4);
    expect(cached.cache.size).toBe(2);
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
