import { describe, expect, it } from 'vitest';
import { OPENROUTER_MODEL, OPENROUTER_URL, resolveProvider, TYPESAFE_URL, DualJevClient } from '../src/asker.js';
import { mapOmpMessages, type OmpMessage } from '../src/map.js';
import { VERBATIM_HEADER } from '../src/render.js';
import hook, { jevCompaction, settingsFromEnv, type OmpCompactionResult } from '../src/hook.js';
import type { JevAsker, JevQuestions, JevState } from '../src/vendor/fast-jev/types.js';

/** Answers every question with a fixed probability, or per-question overrides. */
function fakeAsker(defaultNoul: number, overrides: Record<string, number> = {}): JevAsker & { calls: number } {
  return {
    calls: 0,
    async ask(_state: JevState, questions: JevQuestions) {
      this.calls += 1;
      const answers: Record<string, { type: 'noul'; noul: number }> = {};
      for (const name of Object.keys(questions)) {
        answers[name] = { type: 'noul', noul: overrides[name] ?? defaultNoul };
      }
      return { answers };
    },
  };
}

function transcript(resultChars = 5000): OmpMessage[] {
  const big = 'x'.repeat(resultChars);
  return [
    { role: 'user', content: 'read config.json and tell me the port' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'reading it now' },
        { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'config.json' } },
      ],
    },
    { role: 'toolResult', toolCallId: 'call-1', toolName: 'read', content: [{ type: 'text', text: big }] },
    { role: 'assistant', content: [{ type: 'text', text: 'the port is 8080' }] },
    { role: 'user', content: 'thanks, now deploy' },
  ];
}

const preparation = (messages: OmpMessage[]) => ({
  firstKeptEntryId: 'entry-42',
  messagesToSummarize: messages,
  turnPrefixMessages: [],
  tokensBefore: 120_000,
});

describe('provider resolution', () => {
  it('prefers the TypeSafe endpoint when its key is set', () => {
    const provider = resolveProvider({ env: { TYPESAFE_API_KEY: 'ts', OPENROUTER_API_KEY: 'or' } });
    expect(provider.name).toBe('typesafe');
    expect(provider.url).toBe(TYPESAFE_URL);
  });

  it('falls back to OpenRouter with its own model id', () => {
    const provider = resolveProvider({ env: { OPENROUTER_API_KEY: 'or' } });
    expect(provider.name).toBe('openrouter');
    expect(provider.url).toBe(OPENROUTER_URL);
    expect(provider.model).toBe(OPENROUTER_MODEL);
  });

  it('honours an explicit provider even when the other key exists', () => {
    const provider = resolveProvider({ provider: 'openrouter', env: { TYPESAFE_API_KEY: 'ts', OPENROUTER_API_KEY: 'or' } });
    expect(provider.name).toBe('openrouter');
    expect(provider.apiKey).toBe('or');
  });

  it('refuses to run with no credential', () => {
    expect(() => resolveProvider({ env: {} })).toThrow(/TYPESAFE_API_KEY or OPENROUTER_API_KEY/);
  });

  it('sends the same body to whichever provider and reads noul back', async () => {
    const seen: { url: string; body: unknown }[] = [];
    const client = new DualJevClient({
      env: { OPENROUTER_API_KEY: 'or' },
      fetch: (async (url: string, init: { body: string }) => {
        seen.push({ url, body: JSON.parse(init.body) });
        return { ok: true, status: 200, text: async () => JSON.stringify({ answers: { q: { type: 'noul', noul: 0.9 } } }) };
      }) as unknown as typeof fetch,
    });
    const response = await client.ask({ context: 'c', goal: 'g', history: [] }, { q: { type: 'noul', instructions: 'i' } });
    expect(response.answers.q).toEqual({ type: 'noul', noul: 0.9 });
    expect(seen[0].url).toBe(OPENROUTER_URL);
    expect(seen[0].body).toMatchObject({ model: OPENROUTER_MODEL, questions: { q: { type: 'noul' } } });
  });
});

describe('mapping omp messages', () => {
  it('pairs a standalone toolResult message with its call id', () => {
    const { messages } = mapOmpMessages(transcript(10));
    const uses = messages.flatMap((m) => m.toolUses.map((u) => u.tool_use_id));
    const results = messages.flatMap((m) => (m.toolResults ?? []).map((r) => r.tool_use_id));
    expect(uses).toEqual(['call-1']);
    expect(results).toEqual(['call-1']);
  });

  it('keeps user and assistant text intact', () => {
    const { messages } = mapOmpMessages(transcript(10));
    expect(messages[0]).toMatchObject({ role: 'user', text: 'read config.json and tell me the port' });
    expect(messages.some((m) => m.text === 'the port is 8080')).toBe(true);
  });
});

describe('jevCompaction', () => {
  it('drops a stale result and returns the rest verbatim', async () => {
    const asker = fakeAsker(0.9, { result_t1: 0.1 });
    const outcome = await jevCompaction(preparation(transcript()), asker, { preserveRecentMessages: 1 });
    expect(outcome.compaction).toBeDefined();
    const summary = outcome.compaction!.summary;
    expect(summary).toContain(VERBATIM_HEADER);
    expect(summary).toContain('read config.json and tell me the port');
    expect(summary).toContain('the port is 8080');
    expect(summary).not.toContain('x'.repeat(1000));
    expect(outcome.reduction).toBeGreaterThan(0.5);
  });

  it('passes omp the ids it needs to commit the entry', async () => {
    const outcome = await jevCompaction(preparation(transcript()), fakeAsker(0.9, { result_t1: 0.1 }), {
      preserveRecentMessages: 1,
    });
    const compaction = outcome.compaction as OmpCompactionResult;
    expect(compaction.firstKeptEntryId).toBe('entry-42');
    expect(compaction.tokensBefore).toBe(120_000);
    expect(compaction.preserveData?.jevCompaction).toMatchObject({ version: 1, kept: expect.any(Number) });
  });

  it('declines when Jev keeps everything, so omp can summarize instead', async () => {
    const outcome = await jevCompaction(preparation(transcript()), fakeAsker(0.99), { preserveRecentMessages: 1 });
    expect(outcome.compaction).toBeUndefined();
    expect(outcome.skipped).toBe('insufficient-reduction');
  });

  it('declines when the region holds no tool calls at all', async () => {
    const textOnly: OmpMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ];
    const outcome = await jevCompaction(preparation(textOnly), fakeAsker(0.1), { preserveRecentMessages: 1 });
    expect(outcome.compaction).toBeUndefined();
    expect(outcome.skipped).toBe('no-tool-calls');
  });
});

describe('hook wiring', () => {
  function register() {
    let handler: ((event: unknown, ctx?: unknown) => Promise<unknown>) | undefined;
    const warnings: string[] = [];
    const pi = {
      on: (_event: string, fn: typeof handler) => {
        handler = fn;
      },
      logger: { info: () => {}, warn: (message: unknown) => warnings.push(String(message)) },
    };
    return { pi, warnings, run: (event: unknown) => handler!(event, { ui: { notify: () => {} } }) };
  }

  it('returns a compaction through the registered handler', async () => {
    const { pi, run } = register();
    hook(pi as never, {
      env: { OPENROUTER_API_KEY: 'or' },
      fetch: (async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ answers: { call_t1: { type: 'noul', noul: 0.9 }, result_t1: { type: 'noul', noul: 0.05 } } }),
      })) as unknown as typeof fetch,
      preserveRecentMessages: 1,
    } as never);
    const outcome = (await run({ preparation: preparation(transcript()) })) as { compaction: OmpCompactionResult };
    expect(outcome.compaction.summary).toContain(VERBATIM_HEADER);
  });

  it('degrades to omp compaction when the provider fails', async () => {
    const { pi, warnings, run } = register();
    hook(pi as never, {
      env: { OPENROUTER_API_KEY: 'or' },
      preserveRecentMessages: 1,
      fetch: (async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch,
    } as never);
    const outcome = await run({ preparation: preparation(transcript()) });
    expect(outcome).toBeUndefined();
    expect(warnings.join(' ')).toContain('network down');
  });

  it('degrades when no key is configured', async () => {
    const { pi, warnings, run } = register();
    hook(pi as never, { env: {} } as never);
    expect(await run({ preparation: preparation(transcript()) })).toBeUndefined();
    expect(warnings.join(' ')).toMatch(/TYPESAFE_API_KEY or OPENROUTER_API_KEY/);
  });
});

describe('settingsFromEnv', () => {
  it('reads thresholds and provider from the environment', () => {
    const settings = settingsFromEnv({
      OMP_JEV_PROVIDER: 'openrouter',
      OMP_JEV_KEEP_THRESHOLD: '0.7',
      OMP_JEV_MIN_REDUCTION: '0.4',
    });
    expect(settings).toMatchObject({ provider: 'openrouter', keepThreshold: 0.7, minReductionRatio: 0.4 });
  });

  it('ignores a bogus provider and bad numbers', () => {
    const settings = settingsFromEnv({ OMP_JEV_PROVIDER: 'nonsense', OMP_JEV_KEEP_THRESHOLD: 'abc' });
    expect(settings.provider).toBeUndefined();
    expect(settings.keepThreshold).toBe(0.5);
  });
});
