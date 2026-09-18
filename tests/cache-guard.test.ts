import { describe, expect, it } from 'vitest';
import { judgeCache } from '../src/cache-guard.js';
import { createContextReducer } from '../src/context.js';
import type { OmpMessage } from '../src/map.js';
import type { JevAsker, JevQuestions, JevState } from '../src/vendor/fast-jev/types.js';

/** Numbers taken from live sessions on 2026-09-18. */
const PHOBOS = { input: 1, cacheRead: 420_000 }; // 100% cached, $0.18 per request
const ENYO = { input: 567_031, cacheRead: 36_687 }; // 6% cached, $2.87 per request

function transcript(usage?: { input: number; cacheRead: number }): OmpMessage[] {
  const messages: OmpMessage[] = [
    { role: 'user', content: 'do the thing' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'reading' },
        { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'big.txt' } },
      ],
      ...(usage ? { usage } : {}),
    } as OmpMessage,
    { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: 'X'.repeat(40_000) }] },
    { role: 'user', content: 'now something else' },
  ];
  return messages;
}

const asker = (noul: number): JevAsker => ({
  async ask(_state: JevState, questions: JevQuestions) {
    const answers: Record<string, { type: 'noul'; noul: number }> = {};
    for (const name of Object.keys(questions)) answers[name] = { type: 'noul', noul };
    return { answers };
  },
});

describe('judgeCache', () => {
  it('skips a session the provider is serving from cache', () => {
    const verdict = judgeCache(transcript(PHOBOS));
    expect(verdict.skip).toBe(true);
    expect(verdict.reason).toBe('cache-dominated');
    expect(Math.round(verdict.cacheShare * 100)).toBe(100);
  });

  it('reduces a session paying full price', () => {
    const verdict = judgeCache(transcript(ENYO));
    expect(verdict.skip).toBe(false);
    expect(verdict.reason).toBe('paying-full-price');
    expect(Math.round(verdict.cacheShare * 100)).toBe(6);
  });

  it('reduces when there is no billing evidence yet', () => {
    expect(judgeCache(transcript()).reason).toBe('no-usage');
    expect(judgeCache(transcript()).skip).toBe(false);
  });

  it('honours a custom ceiling', () => {
    // 6% cached is skipped only if the ceiling is dropped below it.
    expect(judgeCache(transcript(ENYO), 0.05).skip).toBe(true);
    expect(judgeCache(transcript(PHOBOS), 1).skip).toBe(false);
  });
});

describe('the reducer respects the guard', () => {
  it('leaves a cached session completely untouched', async () => {
    const skips: string[] = [];
    const reduce = createContextReducer(asker(0.01), {
      minChars: 1000,
      onSkip: (v) => skips.push(v.reason),
    });
    expect(await reduce(transcript(PHOBOS))).toBeUndefined();
    expect(skips).toEqual(['cache-dominated']);
  });

  it('still reduces the expensive session', async () => {
    const reduce = createContextReducer(asker(0.01), { minChars: 1000, preserveRecentMessages: 0 });
    const out = await reduce(transcript(ENYO));
    expect(out).toBeDefined();
    const result = out!.find((m) => (m as { toolCallId?: string }).toolCallId === 'c1') as {
      content: { text: string }[];
    };
    expect(result.content[0].text).toMatch(/read \S+\.txt/);
  });
});
