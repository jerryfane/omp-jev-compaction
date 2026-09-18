import { readFileSync } from 'node:fs';
import { DualJevClient } from '../src/asker.js';
import { mapOmpMessages, type OmpMessage } from '../src/map.js';
import { compact } from '../src/vendor/fast-jev/compact.js';

const path = '/root/.omp/agent/sessions/-gitmoot/2026-08-31T13-46-31-872Z_01a05812-5640-7134-9d94-e0b762b33fa0.jsonl';
const msgs: OmpMessage[] = [];
let chars = 0;
for (const line of readFileSync(path, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let e: any; try { e = JSON.parse(line); } catch { continue; }
  if (e.type !== 'message' || !e.message) continue;
  const size = JSON.stringify(e.message).length;
  if (chars + size > 250000) break;
  chars += size; msgs.push(e.message);
}
const { messages } = mapOmpMessages(msgs);
const sentinel = { role: 'user' as const, text: '(start of history)', toolUses: [] };
const r = await compact([sentinel, ...messages], new DualJevClient({ provider: 'openrouter', timeoutMs: 60000 }), {
  keepThreshold: 0.5, preserveRecentMessages: 6,
});
const d = r.decisions;
const bucket = (v: number) => Math.floor(v * 10) / 10;
const hist = (key: 'keepCall' | 'keepResult') => {
  const h: Record<string, number> = {};
  for (const x of d) if (x.reason !== 'pinned') h[bucket(x[key])] = (h[bucket(x[key])] ?? 0) + 1;
  return h;
};
console.log('decisions:', d.length, 'pinned:', d.filter(x => x.reason === 'pinned').length);
console.log('keepCall histogram:', JSON.stringify(hist('keepCall')));
console.log('keepResult histogram:', JSON.stringify(hist('keepResult')));
console.log('sample:', JSON.stringify(d.filter(x => x.reason !== 'pinned').slice(0, 6).map(x => ({ tool: x.tool, call: x.keepCall, result: x.keepResult, action: x.action }))));
