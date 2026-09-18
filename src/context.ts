import { judgeCache, type CacheVerdict } from './cache-guard.js';
import { mapOmpMessages, type OmpMessage } from './map.js';
import { isSpillNotice, spillPayload, type SpillOptions } from './spill.js';
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
  /** Park dropped payloads on disk and name the file. Default on. */
  spill?: SpillOptions & { enabled?: boolean };
  /** Characters of history scored per Jev request. Jev's window is 32k tokens. */
  maxWindowChars?: number;
  /**
   * Skip sessions whose last request was at least this share cache reads.
   * Set to 1 to disable the guard.
   */
  cacheCeiling?: number;
  onSkip?: (verdict: CacheVerdict) => void;
  /**
   * Only reduce once the context is genuinely big. Below this the round trip
   * costs more than it saves, and a short session needs no help.
   */
  minChars?: number;
  onStats?: (stats: {
    before: number;
    after: number;
    asks: number;
    cached: number;
    dropped: number;
    windows: number;
  }) => void;
}

export const DEFAULT_MIN_CHARS = 150_000;

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

    // Cheap-because-cached sessions must be left alone; rewriting their
    // prefix would break the cache and cost more than it saves.
    const verdict = judgeCache(messages, settings.cacheCeiling);
    if (verdict.skip) {
      settings.onSkip?.(verdict);
      return undefined;
    }

    /**
     * Jev's window is 32k tokens, so a long session can never be shown whole:
     * the core's last fitting stage throws ("history too large for Jev"), which
     * is exactly what happened on a real 200k-token session — the case that
     * needs reduction most. Scoring consecutive windows instead keeps it
     * working; decisions are per tool call, so a window is a valid unit, and
     * the trade is that Jev judges each call against its neighbourhood rather
     * than the entire history.
     */
    const windows = splitIntoWindows(mapped, settings.maxWindowChars ?? DEFAULT_MAX_WINDOW_CHARS);
    const keptAll: typeof mapped = [];
    let dropped = 0;

    for (const window of windows) {
      const sentinel = { role: 'user' as const, text: '(start of this stretch of history)', toolUses: [] };
      const result = await compact([sentinel, ...window], cachingAsker, {
        goal: settings.goal,
        keepThreshold: settings.keepThreshold,
        preserveRecentMessages: settings.preserveRecentMessages ?? 6,
        maxStateTokens: settings.maxStateTokens,
        maxRequestTokens: settings.maxRequestTokens,
        truncateHeadChars: settings.truncateHeadChars,
        allowDroppingCalls: settings.allowDroppingCalls ?? false,
      });
      dropped += result.stats.resultsDropped + result.stats.callsDropped;
      keptAll.push(...result.messages.filter((message) => message !== sentinel));
    }

    settings.onStats?.({
      before,
      after: transcriptChars(keptAll),
      asks: cachingAsker.asks,
      cached: cachingAsker.answered,
      dropped,
      windows: windows.length,
    });
    if (dropped === 0) return undefined;

    return rewriteOmpMessages(messages, keptAll, {
      ...settings.spill,
      headChars: settings.truncateHeadChars ?? settings.spill?.headChars,
    });
  };
}

/** Roughly 15k tokens of state per window, inside Jev's 32k window. */
export const DEFAULT_MAX_WINDOW_CHARS = 60_000;

/**
 * Splits history into consecutive windows without separating a tool call from
 * its result: a window boundary only lands where the next message starts a new
 * assistant turn, so pairing by id still resolves inside one window.
 */
export function splitIntoWindows<T extends { role: string; toolResults?: unknown[] }>(
  messages: readonly T[],
  maxChars: number,
): T[][] {
  const windows: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const message of messages) {
    const chars = JSON.stringify(message).length;
    const wouldSplitPair = message.role === 'user' && (message.toolResults?.length ?? 0) > 0;
    if (current.length > 0 && size + chars > maxChars && !wouldSplitPair) {
      windows.push(current);
      current = [];
      size = 0;
    }
    current.push(message);
    size += chars;
  }
  if (current.length > 0) windows.push(current);
  return windows;
}

/**
 * Applies the decisions back onto omp's own message objects.
 *
 * Only tool results are rewritten, and only the ones Jev let go; every other
 * message object is passed through by reference, so text, thinking blocks and
 * provider metadata stay exactly as omp built them. A rewritten result parks
 * its full payload on disk and names the file, so the reduction is reversible
 * with one `read` instead of re-running the tool.
 */
export function rewriteOmpMessages(
  original: readonly OmpMessage[],
  kept: readonly { toolResults?: { tool_use_id: string; text: string }[]; toolUses: { tool_use_id: string }[] }[],
  spill: SpillOptions & { enabled?: boolean } = {},
): OmpMessage[] {
  const keptResultText = new Map<string, string>();
  const keptCallIds = new Set<string>();
  for (const message of kept) {
    for (const use of message.toolUses) keptCallIds.add(use.tool_use_id);
    for (const result of message.toolResults ?? []) keptResultText.set(result.tool_use_id, result.text);
  }
  const recover = (text: string, fallback: string): string => {
    if (spill.enabled === false || !text || isSpillNotice(text)) return fallback;
    try {
      return spillPayload(text, spill).notice;
    } catch {
      // A read-only or full disk must not cost the turn; keep the plain note.
      return fallback;
    }
  };

  const out: OmpMessage[] = [];
  for (const message of original) {
    if ((message as { role: string }).role !== 'toolResult') {
      out.push(message);
      continue;
    }
    const result = message as { role: 'toolResult'; toolCallId: string; content: { type: string; text?: string }[] };
    const current = result.content.map((part) => part.text ?? '').join('\n');
    const replacement = keptResultText.get(result.toolCallId);
    if (replacement === undefined) {
      // The call itself was dropped; omp still needs a result for the pairing.
      out.push({
        ...result,
        content: [{ type: 'text', text: recover(current, '[jev: result dropped; re-run the tool if needed]') }],
      });
      continue;
    }
    if (current === replacement) {
      out.push(message);
      continue;
    }
    out.push({ ...result, content: [{ type: 'text', text: recover(current, replacement) }] });
  }
  return out;
}
