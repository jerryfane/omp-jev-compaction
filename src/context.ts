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
   * Reduce rarely and re-emit the same decisions in between, so the provider's
   * prompt cache keeps hitting. Default on; `false` restores per-request
   * rewriting plus the cache guard.
   */
  sticky?: boolean;
  /** Re-score once the context has grown by this share since the last rewrite. */
  rewriteGrowth?: number;
  /**
   * Never rewrite more often than this, in requests, whatever the growth.
   * A rewrite costs a cache write, which only pays back over tens of
   * requests, and early in a session +40% growth arrives every few turns.
   */
  minRequestsBetweenRewrites?: number;
  /** Re-score at least this often, in requests. */
  maxRequestsBetweenRewrites?: number;
  onReuse?: (info: { chars: number; replacements: number; requestsSinceRewrite: number }) => void;
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
    rewrites: number;
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
export interface StickyState {
  /** tool_use_id -> the exact replacement text emitted last rewrite. */
  replacements: Map<string, string>;
  baselineChars: number;
  requestsSinceRewrite: number;
  rewrites: number;
}

export function createContextReducer(asker: JevAsker, settings: ContextReducerSettings = {}): ContextReducer {
  const cachingAsker = asker instanceof CachingAsker ? asker : new CachingAsker(asker);
  const sticky = settings.sticky !== false;
  const growth = settings.rewriteGrowth ?? DEFAULT_REWRITE_GROWTH;
  const maxBetween = settings.maxRequestsBetweenRewrites ?? DEFAULT_MAX_REQUESTS_BETWEEN_REWRITES;
  const minBetween = settings.minRequestsBetweenRewrites ?? DEFAULT_MIN_REQUESTS_BETWEEN_REWRITES;
  let state: StickyState | undefined;

  return async function reduceContext(messages: readonly OmpMessage[]): Promise<OmpMessage[] | undefined> {
    const { messages: mapped } = mapOmpMessages(messages);
    const before = transcriptChars(mapped);
    if (before < (settings.minChars ?? DEFAULT_MIN_CHARS)) return undefined;

    /**
     * Without stickiness every request rewrites the prefix, which invalidates
     * the provider's prompt cache: measured at Opus prices, a 420k-token
     * session costs $0.63 cached but $7.68 if rewritten every request. So a
     * cache-served session is only worth touching when rewrites are rare,
     * and the guard below is what keeps the non-sticky path honest.
     */
    if (!sticky) {
      const verdict = judgeCache(messages, settings.cacheCeiling);
      if (verdict.skip) {
        settings.onSkip?.(verdict);
        return undefined;
      }
    }

    const grownPastThreshold = state !== undefined && before > state.baselineChars * (1 + growth);
    const mustRewrite =
      state === undefined ||
      (grownPastThreshold && state.requestsSinceRewrite >= minBetween) ||
      state.requestsSinceRewrite >= maxBetween;
    if (state && !mustRewrite) {
      // Re-emit the previous decisions verbatim: the covered prefix is
      // byte-identical, so the cache still hits, and anything newer is
      // untouched until the next rewrite.
      state.requestsSinceRewrite += 1;
      const reused = applyReplacements(messages, state.replacements);
      settings.onReuse?.({
        chars: before,
        replacements: state.replacements.size,
        requestsSinceRewrite: state.requestsSinceRewrite,
      });
      return reused;
    }

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

    const replacements = buildReplacements(messages, keptAll, {
      ...settings.spill,
      headChars: settings.truncateHeadChars ?? settings.spill?.headChars,
    });
    // Decisions already taken stay in force, so an earlier rewrite's text is
    // never regenerated with a different notice.
    if (state) for (const [id, text] of state.replacements) if (!replacements.has(id)) replacements.set(id, text);

    const out = applyReplacements(messages, replacements);
    const after = transcriptChars(mapOmpMessages(out).messages);
    state = {
      replacements,
      baselineChars: before,
      requestsSinceRewrite: 0,
      rewrites: (state?.rewrites ?? 0) + 1,
    };

    settings.onStats?.({
      before,
      after,
      asks: cachingAsker.asks,
      cached: cachingAsker.answered,
      dropped,
      windows: windows.length,
      rewrites: state.rewrites,
    });
    if (replacements.size === 0) return undefined;
    return out;
  };
}

export const DEFAULT_REWRITE_GROWTH = 0.4;
export const DEFAULT_MAX_REQUESTS_BETWEEN_REWRITES = 40;
export const DEFAULT_MIN_REQUESTS_BETWEEN_REWRITES = 15;


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
export function buildReplacements(
  original: readonly OmpMessage[],
  kept: readonly { toolResults?: { tool_use_id: string; text: string }[]; toolUses: { tool_use_id: string }[] }[],
  spill: SpillOptions & { enabled?: boolean } = {},
): Map<string, string> {
  const keptResultText = new Map<string, string>();
  for (const message of kept) {
    for (const result of message.toolResults ?? []) keptResultText.set(result.tool_use_id, result.text);
  }

  const replacements = new Map<string, string>();
  for (const message of original) {
    if ((message as { role: string }).role !== 'toolResult') continue;
    const result = message as { role: 'toolResult'; toolCallId: string; content: { type: string; text?: string }[] };
    const current = result.content.map((part) => part.text ?? '').join('\n');
    const replacement = keptResultText.get(result.toolCallId);
    if (replacement !== undefined && replacement === current) continue; // untouched

    const fallback = replacement ?? '[jev: result dropped; re-run the tool if needed]';
    if (spill.enabled === false || !current || isSpillNotice(current)) {
      if (fallback !== current) replacements.set(result.toolCallId, fallback);
      continue;
    }
    try {
      replacements.set(result.toolCallId, spillPayload(current, spill).notice);
    } catch {
      // A read-only or full disk must not cost the turn.
      if (fallback !== current) replacements.set(result.toolCallId, fallback);
    }
  }
  return replacements;
}

/**
 * Emits the messages with the recorded replacements applied. Every other
 * message object is passed through by reference, and a replacement is always
 * the same string for the same call, which is what keeps the prefix stable
 * between rewrites.
 */
export function applyReplacements(
  messages: readonly OmpMessage[],
  replacements: ReadonlyMap<string, string>,
): OmpMessage[] {
  return messages.map((message) => {
    if ((message as { role: string }).role !== 'toolResult') return message;
    const result = message as { role: 'toolResult'; toolCallId: string; content: { type: string; text?: string }[] };
    const replacement = replacements.get(result.toolCallId);
    if (replacement === undefined) return message;
    return { ...result, content: [{ type: 'text', text: replacement }] };
  });
}

/** Kept for callers that score and apply in one step. */
export function rewriteOmpMessages(
  original: readonly OmpMessage[],
  kept: readonly { toolResults?: { tool_use_id: string; text: string }[]; toolUses: { tool_use_id: string }[] }[],
  spill: SpillOptions & { enabled?: boolean } = {},
): OmpMessage[] {
  return applyReplacements(original, buildReplacements(original, kept, spill));
}
