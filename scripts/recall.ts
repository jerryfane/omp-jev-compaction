/**
 * Does the agent still know what it needs after reduction?
 *
 * Builds a long transcript with facts planted inside tool outputs, reduces it
 * at several thresholds, then asks a real model the same questions against the
 * full and the reduced context and compares answers to the planted truth.
 *
 * Usage: npx tsx scripts/recall.ts [thresholds]
 */
import { writeFileSync } from 'node:fs';
import { DualJevClient } from '../src/asker.js';
import { CachingAsker, rewriteOmpMessages } from '../src/context.js';
import { readFileSync } from 'node:fs';
import { mapOmpMessages, type OmpMessage } from '../src/map.js';
import { transcriptChars } from '../src/render.js';
import { compact } from '../src/vendor/fast-jev/compact.js';
import type { Message } from '../src/vendor/fast-jev/types.js';

const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) throw new Error('OPENROUTER_API_KEY required');
const ANSWER_MODEL = process.env.RECALL_MODEL ?? 'google/gemini-3.8-flash';

interface Probe {
  question: string;
  answer: string;
  /** Referenced again later in the conversation, so it should survive. */
  loadBearing: boolean;
}

const probes: Probe[] = [
  { question: 'What port does the service bind to, per config.json?', answer: '8471', loadBearing: true },
  { question: 'What is the exact error code from the failing migration?', answer: 'PG-42703', loadBearing: true },
  { question: 'Which file holds the retry policy?', answer: 'src/net/retry-policy.ts', loadBearing: true },
  { question: 'What is the deploy token prefix printed by the auth check?', answer: 'dpl_9f2c', loadBearing: true },
  { question: 'How many rows did the backfill report?', answer: '18342', loadBearing: false },
  { question: 'What was the git sha of the baseline benchmark?', answer: 'a91f7be', loadBearing: false },
  { question: 'What temp directory did the sandbox probe use?', answer: '/tmp/probe-7741', loadBearing: false },
  { question: 'What is the checksum of the uploaded artifact?', answer: 'sha256:5c1d0e', loadBearing: false },
];

const noise = (tag: string, lines: number) =>
  Array.from({ length: lines }, (_, i) => `${tag} line ${i + 1}: routine output with no lasting significance`).join('\n');

/** A transcript where each planted fact sits inside one tool result. */
function buildTranscript(): OmpMessage[] {
  const messages: OmpMessage[] = [
    { role: 'user', content: 'Get the service booting: check config, run the migration, fix what breaks.' },
  ];
  probes.forEach((probe, index) => {
    const id = `call-${index}`;
    messages.push({
      role: 'assistant',
      content: [
        { type: 'text', text: `Step ${index + 1}: gathering evidence.` },
        { type: 'toolCall', id, name: index % 2 ? 'bash' : 'read', arguments: { target: `step-${index}` } },
      ],
    });
    messages.push({
      role: 'toolResult',
      toolCallId: id,
      toolName: index % 2 ? 'bash' : 'read',
      content: [
        {
          type: 'text',
          text: `${noise(`step${index}`, 260)}\n>>> ${probe.question} -> ${probe.answer}\n${noise(`step${index}b`, 260)}`,
        },
      ],
    });
    // Load-bearing facts get referenced again in plain assistant text, which is
    // never touched, so the agent has a second route to them.
    if (probe.loadBearing) {
      messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: `Noting for later: this matters for the fix (${probe.answer}).` }],
      });
    }
  });
  messages.push({ role: 'user', content: 'Before you continue, answer my questions about what you found.' });
  return messages;
}

function serialize(messages: readonly Message[]): string {
  const out: string[] = [];
  for (const message of messages) {
    if (message.text.trim()) out.push(`${message.role.toUpperCase()}: ${message.text}`);
    for (const use of message.toolUses) out.push(`TOOL CALL ${use.tool} ${JSON.stringify(use.input)}`);
    for (const result of message.toolResults ?? []) out.push(`TOOL RESULT: ${result.text}`);
  }
  return out.join('\n');
}

async function askModel(context: string, question: string): Promise<string> {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: ANSWER_MODEL,
      // Reasoning tokens are billed against max_tokens, and at 40 they ate the
      // whole budget: every reply came back empty or one character long.
      max_tokens: 400,
      reasoning: { effort: 'low' },
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'Answer only from the transcript. Reply with the exact value and nothing else. ' +
            'If the transcript no longer contains it, reply exactly UNKNOWN.',
        },
        { role: 'user', content: `Transcript:\n${context}\n\nQuestion: ${question}` },
      ],
    }),
  });
  const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  return (body.choices?.[0]?.message?.content ?? '').trim();
}

async function score(context: string, label: string) {
  const results = [];
  for (const probe of probes) {
    const reply = await askModel(context, probe.question);
    const correct = reply.toLowerCase().includes(probe.answer.toLowerCase());
    results.push({ q: probe.question, expect: probe.answer, reply, correct, loadBearing: probe.loadBearing, recoverable: false });
  }
  const bearing = results.filter((r) => r.loadBearing);
  const rest = results.filter((r) => !r.loadBearing);
  const pct = (rows: typeof results) => (rows.length ? Math.round((rows.filter((r) => r.correct).length / rows.length) * 100) : 0);
  // A miss that is still on disk is repairable: the agent can read the file.
  for (const row of results) {
    if (row.correct) continue;
    const paths = [...context.matchAll(/read (\S+\.txt)/g)].map((m) => m[1]);
    row.recoverable = paths.some((path) => {
      try {
        return readFileSync(path, 'utf8').includes(row.expect);
      } catch {
        return false;
      }
    });
  }
  const summary = {
    label,
    recoverableMisses: results.filter((r) => !r.correct && r.recoverable).length,
    permanentMisses: results.filter((r) => !r.correct && !r.recoverable).length,
    contextChars: context.length,
    overallRecall: pct(results),
    loadBearingRecall: pct(bearing),
    incidentalRecall: pct(rest),
    unknowns: results.filter((r) => r.reply.toUpperCase().includes('UNKNOWN')).length,
  };
  console.log(JSON.stringify(summary));
  return { summary, results };
}

const source = buildTranscript();
const { messages: mapped } = mapOmpMessages(source);
const sentinel = { role: 'user' as const, text: '(start of history)', toolUses: [] };
const thresholds = (process.argv[2] ?? '0.2,0.3').split(',').map(Number);

const runs = [await score(serialize(mapped), 'full context (no reduction)')];
for (const keepThreshold of thresholds) {
  const client = new DualJevClient({ provider: 'openrouter', timeoutMs: 60_000 });
  const result = await compact([sentinel, ...mapped], new CachingAsker(client), {
    keepThreshold,
    preserveRecentMessages: 6,
  });
  const kept = result.messages.filter((m) => m !== sentinel);
  // Same path omp takes: dropped payloads are parked on disk with a pointer.
  const rewritten = mapOmpMessages(rewriteOmpMessages(source, kept, { dir: '/tmp/jev-recall-spill' })).messages;
  const run = await score(serialize(rewritten), `reduced at ${keepThreshold}`);
  runs.push({
    ...run,
    summary: {
      ...run.summary,
      charsSavedPct: +(((transcriptChars(mapped) - transcriptChars(kept)) / transcriptChars(mapped)) * 100).toFixed(1),
      resultsDropped: result.stats.resultsDropped,
      callsDropped: result.stats.callsDropped,
    },
  });
}

writeFileSync('/tmp/jev-recall.json', JSON.stringify({ model: ANSWER_MODEL, runs }, null, 2));
console.log('wrote /tmp/jev-recall.json');
