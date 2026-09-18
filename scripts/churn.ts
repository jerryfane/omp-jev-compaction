/**
 * Replays a real session request by request and reports how often the sticky
 * reducer rewrites the prefix, plus whether the covered prefix stayed
 * byte-identical between rewrites.
 *
 * Usage: npx tsx scripts/churn.ts <session.jsonl> [requests]
 */
import { readFileSync } from 'node:fs';
import { DualJevClient } from '../src/asker.js';
import { CachingAsker, createContextReducer } from '../src/context.js';
import { mapOmpMessages, type OmpMessage } from '../src/map.js';
import { transcriptChars } from '../src/render.js';

const [, , path, limitArg] = process.argv;
if (!path) throw new Error('usage: churn.ts <session.jsonl> [requests]');
const limit = Number(limitArg ?? '60');

const all: OmpMessage[] = [];
for (const line of readFileSync(path, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let entry: { type?: string; message?: OmpMessage };
  try {
    entry = JSON.parse(line);
  } catch {
    continue;
  }
  if (entry.type === 'message' && entry.message) all.push(entry.message);
}

let rewrites = 0;
let reuses = 0;
const reduce = createContextReducer(
  new CachingAsker(new DualJevClient({ provider: 'openrouter', timeoutMs: 60_000 })),
  {
    keepThreshold: 0.2,
    minChars: 50_000,
    spill: { dir: '/tmp/jev-churn-spill' },
    onStats: () => {
      rewrites += 1;
    },
    onReuse: () => {
      reuses += 1;
    },
  },
);

/** Replays the session as a growing context, one request per assistant turn. */
const checkpoints: { at: number; prefixHash: string; chars: number }[] = [];
const hash = (messages: OmpMessage[], count: number) =>
  JSON.stringify(messages.slice(0, count)).length + ':' + JSON.stringify(messages.slice(0, count)).slice(0, 200);

let requests = 0;
let stablePrefixChecks = 0;
let prefixBreaks = 0;
let coveredCount = 0;
let lastPrefix = '';

for (let end = 20; end <= all.length && requests < limit; end += 4) {
  const slice = all.slice(0, end);
  if (transcriptChars(mapOmpMessages(slice).messages) < 50_000) continue;
  const out = await reduce(slice);
  requests += 1;
  if (!out) continue;
  if (coveredCount === 0) coveredCount = Math.max(1, Math.floor(end * 0.5));
  const prefix = hash(out, coveredCount);
  if (lastPrefix) {
    stablePrefixChecks += 1;
    if (prefix !== lastPrefix) prefixBreaks += 1;
  }
  lastPrefix = prefix;
  checkpoints.push({ at: requests, prefixHash: prefix.slice(0, 24), chars: transcriptChars(mapOmpMessages(out).messages) });
}

console.log(
  JSON.stringify(
    {
      messagesInSession: all.length,
      requestsReplayed: requests,
      rewrites,
      reuses,
      requestsPerRewrite: rewrites ? +(requests / rewrites).toFixed(1) : null,
      prefixChecks: stablePrefixChecks,
      prefixBreaks,
      firstChars: checkpoints[0]?.chars,
      lastChars: checkpoints.at(-1)?.chars,
    },
    null,
    1,
  ),
);
