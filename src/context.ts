import { mapOmpMessages, type OmpMessage } from './map.js';
import { transcriptChars } from './render.js';
import { compact } from './vendor/fast-jev/compact.js';
import type { CompactOptions, JevAnswer, JevAsker, JevQuestions, JevState } from './vendor/fast-jev/types.js';

/**
 * Answers repeated questions from memory.
 *
 * The context hook runs on every request, but a judgement about one tool call
 * rarely changes between turns, and each ask costs a round trip. Caching by
 * question name means only newly seen calls reach the provider.
 */
export class CachingAsker implements JevAsker {
  readonly cache = new Map<string, JevAnswer>();
  asks = 0;
  answered = 0;

  constructor(private readonly inner: JevAsker) {}

  async ask(state: JevState, questions: JevQuestions) {
    const missing: JevQuestions = {};
    const answers: Record<string, JevAnswer> = {};
    for (const [name, question] of Object.entries(questions)) {
      const cached = this.cache.get(name);
      if (cached) {
        answers[name] = cached;
        this.answered += 1;
      } else {
        missing[name] = question;
      }
    }
    if (Object.keys(missing).length > 0) {
      this.asks += 1;
      const fresh = await this.inner.ask(state, missing);
      for (const [name, answer] of Object.entries(fresh.answers)) {
        this.cache.set(name, answer);
        answers[name] = answer;
      }
    }
    return { answers };
  }
}

export interface ContextReducerSettings extends CompactOptions {
  /**
   * Only reduce once the context is genuinely big. Below this the round trip
   * costs more than it saves, and a short session needs no help.
   */
  minChars?: number;
  onStats?: (stats: { before: number; after: number; asks: number; cached: number; dropped: number }) => void;
}

export const DEFAULT_MIN_CHARS = 200_000;

/**
 * Reduces one request's messages, or returns undefined to leave them alone
 * (context too small, or Jev kept everything).
 */
export type ContextReducer = (messages: readonly OmpMessage[]) => Promise<OmpMessage[] | undefined>;

/**
 * Builds a `context` handler: per-request verbatim reduction.
 *
 * omp's `context` event replaces the messages for one call only, so session
 * history stays intact on disk and nothing is destroyed — the reduction is
 * what this turn sends, not what the session remembers. That makes a wrong
 * judgement recoverable by construction, unlike a summary.
 */
export function createContextReducer(asker: JevAsker, settings: ContextReducerSettings = {}): ContextReducer {
  const cachingAsker = asker instanceof CachingAsker ? asker : new CachingAsker(asker);

  return async function reduceContext(messages: readonly OmpMessage[]): Promise<OmpMessage[] | undefined> {
    const { messages: mapped } = mapOmpMessages(messages);
    const before = transcriptChars(mapped);
    if (before < (settings.minChars ?? DEFAULT_MIN_CHARS)) return undefined;

    const sentinel = { role: 'user' as const, text: '(start of history)', toolUses: [] };
    const result = await compact([sentinel, ...mapped], cachingAsker, {
      goal: settings.goal,
      keepThreshold: settings.keepThreshold,
      preserveRecentMessages: settings.preserveRecentMessages ?? 6,
      maxStateTokens: settings.maxStateTokens,
      maxRequestTokens: settings.maxRequestTokens,
      truncateHeadChars: settings.truncateHeadChars,
      allowDroppingCalls: settings.allowDroppingCalls ?? false,
    });

    const dropped = result.stats.resultsDropped + result.stats.callsDropped;
    settings.onStats?.({
      before,
      after: transcriptChars(result.messages.filter((m) => m !== sentinel)),
      asks: cachingAsker.asks,
      cached: cachingAsker.answered,
      dropped,
    });
    if (dropped === 0) return undefined;

    return rewriteOmpMessages(messages, result.messages);
  };
}

/**
 * Applies the decisions back onto omp's own message objects.
 *
 * Only tool results are rewritten, and only the ones Jev let go; every other
 * message object is passed through by reference, so text, thinking blocks and
 * provider metadata stay exactly as omp built them.
 */
export function rewriteOmpMessages(
  original: readonly OmpMessage[],
  kept: readonly { toolResults?: { tool_use_id: string; text: string }[]; toolUses: { tool_use_id: string }[] }[],
): OmpMessage[] {
  const keptResultText = new Map<string, string>();
  const keptCallIds = new Set<string>();
  for (const message of kept) {
    for (const use of message.toolUses) keptCallIds.add(use.tool_use_id);
    for (const result of message.toolResults ?? []) keptResultText.set(result.tool_use_id, result.text);
  }

  const out: OmpMessage[] = [];
  for (const message of original) {
    if ((message as { role: string }).role !== 'toolResult') {
      out.push(message);
      continue;
    }
    const result = message as { role: 'toolResult'; toolCallId: string; content: { type: string; text?: string }[] };
    const replacement = keptResultText.get(result.toolCallId);
    if (replacement === undefined) {
      // The call itself was dropped; omp still needs a result for the pairing.
      out.push({ ...result, content: [{ type: 'text', text: '[jev: result dropped; re-run the tool if needed]' }] });
      continue;
    }
    const current = result.content.map((part) => part.text ?? '').join('\n');
    if (current === replacement) {
      out.push(message);
      continue;
    }
    out.push({ ...result, content: [{ type: 'text', text: replacement }] });
  }
  return out;
}
