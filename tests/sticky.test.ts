import { describe, expect, it } from 'vitest';
import { CachingAsker, createContextReducer } from '../src/context.js';
import type { OmpMessage } from '../src/map.js';
import type { JevAnswer, JevAsker, JevQuestions, JevState } from '../src/vendor/fast-jev/types.js';

function asker(noul = 0.01) {
  const self: JevAsker & { calls: number } = {
    calls: 0,
    async ask(_state: JevState, questions: JevQuestions) {
      self.calls += 1;
      const answers: Record<string, JevAnswer> = {};
      for (const name of Object.keys(questions)) answers[name] = { type: 'noul', noul };
      return { answers };
    },
  };
  return self;
}

/** A turn: assistant makes a call, a big result comes back. */
function turn(id: string, size = 20_000): OmpMessage[] {
  return [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: `step ${id}` },
        { type: 'toolCall', id, name: 'read', arguments: { path: `${id}.txt` } },
      ],
    },
    { role: 'toolResult', toolCallId: id, toolName: 'read', content: [{ type: 'text', text: `${id}:${'D'.repeat(size)}` }] },
  ];
}

const base = (turns: number, size = 20_000): OmpMessage[] => [
  { role: 'user', content: 'begin' },
  ...Array.from({ length: turns }, (_, i) => turn(`c${i}`, size)).flat(),
];

const prefixOf = (messages: OmpMessage[], count: number) => JSON.stringify(messages.slice(0, count));

describe('sticky reduction', () => {
  it('re-emits a byte-identical prefix between rewrites', async () => {
    const jev = asker();
    const reduce = createContextReducer(new CachingAsker(jev), { minChars: 1000, preserveRecentMessages: 0 });
    const start = base(6);

    const first = await reduce(start);
    expect(first).toBeDefined();
    const asksAfterFirst = jev.calls;

    // A later turn arrives; the earlier messages must come back unchanged.
    const grown = [...start, ...turn('c6', 500)];
    const second = await reduce(grown);
    expect(second).toBeDefined();
    expect(prefixOf(second!, start.length)).toBe(prefixOf(first!, start.length));
    expect(jev.calls).toBe(asksAfterFirst); // no new scoring
  });

  it('leaves a result that arrived after the last rewrite untouched', async () => {
    const reduce = createContextReducer(new CachingAsker(asker()), { minChars: 1000, preserveRecentMessages: 0 });
    const start = base(6);
    await reduce(start);

    const fresh = turn('fresh', 30_000);
    const out = await reduce([...start, ...fresh]);
    const freshResult = out!.find((m) => (m as { toolCallId?: string }).toolCallId === 'fresh') as {
      content: { text: string }[];
    };
    expect(freshResult.content[0].text).toContain('D'.repeat(1000));
  });

  it('rewrites once the context has grown past the threshold', async () => {
    const rewrites: number[] = [];
    const reduce = createContextReducer(new CachingAsker(asker()), {
      minChars: 1000,
      preserveRecentMessages: 0,
      rewriteGrowth: 0.3,
      minRequestsBetweenRewrites: 0, // growth alone may trigger here
      onStats: (s) => rewrites.push(s.rewrites),
    });
    await reduce(base(4));
    expect(rewrites).toEqual([1]);
    await reduce(base(4, 20_100)); // barely grown: reused, no rewrite
    expect(rewrites).toEqual([1]);
    await reduce(base(9)); // well past +30%
    expect(rewrites).toEqual([1, 2]);
  });

  it('refuses to rewrite too often even when growth says so', async () => {
    const rewrites: number[] = [];
    const reduce = createContextReducer(new CachingAsker(asker()), {
      minChars: 1000,
      preserveRecentMessages: 0,
      rewriteGrowth: 0.1,
      minRequestsBetweenRewrites: 5,
      onStats: (s) => rewrites.push(s.rewrites),
    });
    await reduce(base(4));
    // Each step grows well past +10%, but the floor holds the rewrite back.
    await reduce(base(6));
    await reduce(base(9));
    await reduce(base(13));
    expect(rewrites).toEqual([1]);
    await reduce(base(18));
    await reduce(base(24));
    expect(rewrites).toEqual([1]); // floor still holding
    await reduce(base(30)); // five reuses done, now it may rewrite
    expect(rewrites).toEqual([1, 2]);
  });

  it('rewrites again after the request ceiling even without growth', async () => {
    const rewrites: number[] = [];
    const reduce = createContextReducer(new CachingAsker(asker()), {
      minChars: 1000,
      preserveRecentMessages: 0,
      maxRequestsBetweenRewrites: 3,
      onStats: (s) => rewrites.push(s.rewrites),
    });
    const fixed = base(5);
    await reduce(fixed);
    await reduce(fixed);
    await reduce(fixed);
    expect(rewrites).toEqual([1]); // unchanged context, nothing re-scored
    await reduce(fixed);
    expect(rewrites).toEqual([1]); // a ceiling of 3 permits three reuses
    await reduce(fixed); // fifth request: ceiling reached
    expect(rewrites).toEqual([1, 2]);
  });

  it('reports rewrites so churn can be measured', async () => {
    const rewrites: number[] = [];
    const reuses: number[] = [];
    const reduce = createContextReducer(new CachingAsker(asker()), {
      minChars: 1000,
      preserveRecentMessages: 0,
      maxRequestsBetweenRewrites: 2,
      onStats: (s) => rewrites.push(s.rewrites),
      onReuse: (r) => reuses.push(r.requestsSinceRewrite),
    });
    const fixed = base(4);
    for (let i = 0; i < 5; i += 1) await reduce(fixed);
    // ceiling 2: rewrite, reuse, reuse, rewrite, reuse
    expect(rewrites).toEqual([1, 2]);
    expect(reuses).toEqual([1, 2, 1]);
  });

  it('keeps earlier decisions in force across a rewrite', async () => {
    const jev = asker();
    const reduce = createContextReducer(new CachingAsker(jev), {
      minChars: 1000,
      preserveRecentMessages: 0,
      maxRequestsBetweenRewrites: 1,
    });
    const start = base(5);
    const first = await reduce(start);
    const second = await reduce([...start, ...turn('later', 25_000)]);
    // The rewrite re-scored, but the old calls keep their original text.
    expect(prefixOf(second!, start.length)).toBe(prefixOf(first!, start.length));
  });
});
