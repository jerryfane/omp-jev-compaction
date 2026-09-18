import type { OmpMessage } from './map.js';

/**
 * omp's `Usage`, as attached to each assistant message (`packages/ai/src/types.ts`).
 * Only the two fields this guard needs are declared.
 */
export interface OmpUsage {
  input?: number;
  cacheRead?: number;
}

export interface CacheVerdict {
  /** True when reduction should be skipped. */
  skip: boolean;
  cacheShare: number;
  input: number;
  cacheRead: number;
  reason: 'no-usage' | 'cache-dominated' | 'paying-full-price';
}

export const DEFAULT_CACHE_CEILING = 0.8;

/**
 * Decides whether a session is already cheap because the provider is serving
 * its context from cache.
 *
 * This is the difference between saving money and wasting it. Measured across
 * 14 live sessions on one machine: thirteen ran at 98-100% cache hits and cost
 * $0.05-$0.40 per request, while one ran at 6% and cost $2.87. Reduction
 * rewrites the start of the conversation, which invalidates the provider's
 * prefix cache, so on a cache-dominated session it converts a $0.18 request
 * into a full-price one and saves nothing. Those sessions are left untouched.
 */
export function judgeCache(messages: readonly OmpMessage[], ceiling = DEFAULT_CACHE_CEILING): CacheVerdict {
  let usage: OmpUsage | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index] as { role?: string; usage?: OmpUsage };
    if (candidate.role !== 'assistant' || !candidate.usage) continue;
    const input = candidate.usage.input ?? 0;
    const cacheRead = candidate.usage.cacheRead ?? 0;
    if (input + cacheRead === 0) continue;
    usage = candidate.usage;
    break;
  }

  if (!usage) {
    // No billing evidence: reduce, because an unmeasured session is more
    // likely to be a fresh expensive one than a cached cheap one.
    return { skip: false, cacheShare: 0, input: 0, cacheRead: 0, reason: 'no-usage' };
  }

  const input = usage.input ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheShare = cacheRead / (input + cacheRead);
  return cacheShare >= ceiling
    ? { skip: true, cacheShare, input, cacheRead, reason: 'cache-dominated' }
    : { skip: false, cacheShare, input, cacheRead, reason: 'paying-full-price' };
}
