/**
 * Proves reduction survives a session far larger than Jev's 32k window, the
 * case that failed live with "history too large for Jev".
 *
 * Usage: npx tsx scripts/huge.ts <session.jsonl> [charBudget]
 */
import { readFileSync } from 'node:fs';
import { DualJevClient } from '../src/asker.js';
import { CachingAsker, createContextReducer, splitIntoWindows } from '../src/context.js';
import { mapOmpMessages, type OmpMessage } from '../src/map.js';
import { transcriptChars } from '../src/render.js';

const [, , path, budgetArg] = process.argv;
if (!path) throw new Error('usage: huge.ts <session.jsonl> [charBudget]');
const budget = Number(budgetArg ?? '1200000');

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
  const size = JSON.stringify(entry.message).length;
  if (chars + size > budget) break;
  chars += size;
  messages.push(entry.message);
}

const { messages: mapped } = mapOmpMessages(messages);
const before = transcriptChars(mapped);
console.log(
  JSON.stringify({
    messages: messages.length,
    chars: before,
    estTokens: Math.round(before / 4),
    windows: splitIntoWindows(mapped, 60_000).length,
  }),
);

const started = Date.now();
const reduce = createContextReducer(new CachingAsker(new DualJevClient({ provider: 'openrouter', timeoutMs: 60_000 })), {
  keepThreshold: 0.2,
  minChars: 1000,
  onStats: (stats) => console.log(JSON.stringify(stats)),
  spill: { dir: '/tmp/jev-huge-spill' },
});

const out = await reduce(messages);
if (!out) {
  console.log('no reduction produced');
} else {
  const after = transcriptChars(mapOmpMessages(out).messages);
  console.log(
    JSON.stringify({
      charsBefore: before,
      charsAfter: after,
      percentSaved: +(((before - after) / before) * 100).toFixed(1),
      seconds: +((Date.now() - started) / 1000).toFixed(1),
    }),
  );
}
