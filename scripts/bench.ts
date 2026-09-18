/**
 * Measures Jev reduction against a real omp session transcript.
 *
 * Usage: npx tsx scripts/bench.ts <session.jsonl> [charBudget]
 *
 * Reports characters and estimated tokens before and after at several keep
 * thresholds, the Jev requests and their billed cost, and what the saved
 * tokens would be worth per request at real model prices.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { DualJevClient } from '../src/asker.js';
import { CachingAsker } from '../src/context.js';
import { mapOmpMessages, type OmpMessage } from '../src/map.js';
import { transcriptChars } from '../src/render.js';
import { compact } from '../src/vendor/fast-jev/compact.js';

const [, , sessionPath, budgetArg] = process.argv;
if (!sessionPath) throw new Error('usage: bench.ts <session.jsonl> [charBudget]');
const charBudget = Number(budgetArg ?? '250000');

/** Model input prices per million tokens, for the saved-token valuation. */
const PRICES: Record<string, number> = {
  'claude-opus-5': 15,
  'gpt-5.2': 1.25,
  'gemini-3.8-flash': 0.3,
};
const JEV_INPUT_PRICE = 0.042;

function loadMessages(path: string, budget: number): OmpMessage[] {
  const messages: OmpMessage[] = [];
  let chars = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let entry: { type?: string; message?: OmpMessage };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== 'message' || !entry.message) continue;
    const message = entry.message;
    const size = JSON.stringify(message).length;
    if (chars + size > budget) break;
    chars += size;
    messages.push(message);
  }
  return messages;
}

const estTokens = (chars: number) => Math.round(chars / 4);

interface Usage {
  requests: number;
  inputTokens: number;
  cost: number;
}

/** Wraps fetch to record what each decision request actually billed. */
function meteredFetch(usage: Usage): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const response = await fetch(url, init);
    const text = await response.text();
    usage.requests += 1;
    try {
      const parsed = JSON.parse(text) as { usage?: { input_tokens?: number; cost?: number } };
      usage.inputTokens += parsed.usage?.input_tokens ?? 0;
      usage.cost += parsed.usage?.cost ?? 0;
    } catch {
      /* parse errors surface in the client */
    }
    return { ok: response.ok, status: response.status, text: async () => text } as unknown as Response;
  }) as unknown as typeof fetch;
}

const messages = loadMessages(sessionPath, charBudget);
const { messages: mapped } = mapOmpMessages(messages);
const before = transcriptChars(mapped);
const sentinel = { role: 'user' as const, text: '(start of history)', toolUses: [] };

const rows: Record<string, unknown>[] = [];
for (const keepThreshold of (process.env.THRESHOLDS ?? "0.2,0.25,0.3,0.35,0.5").split(",").map(Number)) {
  const usage: Usage = { requests: 0, inputTokens: 0, cost: 0 };
  const client = new DualJevClient({ provider: 'openrouter', fetch: meteredFetch(usage), timeoutMs: 60_000 });
  const started = Date.now();
  const result = await compact([sentinel, ...mapped], new CachingAsker(client), {
    keepThreshold,
    preserveRecentMessages: 6,
    allowDroppingCalls: process.env.ALLOW_DROP_CALLS === '1',
  });
  const after = transcriptChars(result.messages.filter((m) => m !== sentinel));
  const tokensSaved = estTokens(before) - estTokens(after);
  rows.push({
    mode: process.env.ALLOW_DROP_CALLS === '1' ? 'calls may be dropped' : 'call records kept',
    keepThreshold,
    charsBefore: before,
    charsAfter: after,
    percentSaved: +(((before - after) / before) * 100).toFixed(1),
    tokensBefore: estTokens(before),
    tokensAfter: estTokens(after),
    tokensSaved,
    calls: result.stats.calls,
    kept: result.stats.kept,
    resultsDropped: result.stats.resultsDropped,
    callsDropped: result.stats.callsDropped,
    jevRequests: usage.requests,
    jevInputTokens: usage.inputTokens,
    jevCostUsd: +usage.cost.toFixed(6),
    msElapsed: Date.now() - started,
    savedValueUsd: Object.fromEntries(
      Object.entries(PRICES).map(([model, price]) => [model, +((tokensSaved / 1e6) * price).toFixed(4)]),
    ),
  });
  console.log(JSON.stringify(rows.at(-1)));
}

const report = {
  session: sessionPath,
  messages: messages.length,
  mappedMessages: mapped.length,
  jevInputPricePerMillion: JEV_INPUT_PRICE,
  modelInputPrices: PRICES,
  rows,
};
writeFileSync('/tmp/jev-bench.json', JSON.stringify(report, null, 2));
console.log('wrote /tmp/jev-bench.json');
