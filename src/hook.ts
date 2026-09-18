import { DualJevClient, type DualJevClientOptions, type JevProviderName } from './asker.js';
import { CachingAsker, createContextReducer, type ContextReducer } from './context.js';
import { mapOmpMessages, type OmpMessage } from './map.js';
import { renderVerbatim, transcriptChars } from './render.js';
import { compact } from './vendor/fast-jev/compact.js';
import type { CompactOptions, CompactResult, JevAsker } from './vendor/fast-jev/types.js';

/** omp's `CompactionResult`, structurally (packages/agent/src/compaction). */
export interface OmpCompactionResult {
  summary: string;
  shortSummary?: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
  preserveData?: Record<string, unknown>;
}

export interface OmpCompactionPreparation {
  firstKeptEntryId: string;
  messagesToSummarize: OmpMessage[];
  turnPrefixMessages: OmpMessage[];
  tokensBefore: number;
}

export interface JevHookSettings extends CompactOptions {
  provider?: JevProviderName;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  /**
   * Minimum share of characters the Jev pass must remove before its verbatim
   * history replaces omp's own compaction. Below it, returning nothing lets
   * omp run its normal method order, which is the better outcome: a verbatim
   * transcript that saved nothing is worse than a real summary.
   */
  minReductionRatio?: number;
}
const DEFAULTS = {
  keepThreshold: 0.5,
  /**
   * Zero, unlike the library's own default of 6. omp hands the hook only the
   * region it is already going to discard and protects the tail separately as
   * `recentMessages`, so pinning "recent" messages inside that region would
   * pin the whole region on short sessions (observed: calls=1 pinned=1,
   * nothing scoreable). The first message stays pinned by the library.
   */
  preserveRecentMessages: 0,
  minReductionRatio: 0.25,
  timeoutMs: 10_000,
};

function numberFrom(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : fallback;
}

/** Reads settings from the environment so no omp-side config schema is needed. */
export function settingsFromEnv(env: Record<string, string | undefined> = process.env): JevHookSettings {
  const provider = env.OMP_JEV_PROVIDER?.trim().toLowerCase();
  return {
    provider: provider === 'typesafe' || provider === 'openrouter' ? provider : undefined,
    model: env.OMP_JEV_MODEL?.trim() || undefined,
    baseUrl: env.OMP_JEV_BASE_URL?.trim() || undefined,
    keepThreshold: numberFrom(env.OMP_JEV_KEEP_THRESHOLD, DEFAULTS.keepThreshold),
    preserveRecentMessages: numberFrom(env.OMP_JEV_PRESERVE_RECENT, DEFAULTS.preserveRecentMessages),
    minReductionRatio: numberFrom(env.OMP_JEV_MIN_REDUCTION, DEFAULTS.minReductionRatio),
    // Opt in explicitly to let a low score remove the call record itself.
    allowDroppingCalls: env.OMP_JEV_ALLOW_DROPPING_CALLS === '1',
    timeoutMs: numberFrom(env.OMP_JEV_TIMEOUT_MS, DEFAULTS.timeoutMs),
  };
}

export interface JevCompactionOutcome {
  compaction?: OmpCompactionResult;
  /** Why no compaction was produced, for logging and tests. */
  skipped?: 'no-tool-calls' | 'insufficient-reduction';
  result?: CompactResult;
  reduction: number;
}

/**
 * Scores the region omp is about to discard and, when the saving is real,
 * returns that region as verbatim retained history.
 */
export async function jevCompaction(
  preparation: OmpCompactionPreparation,
  asker: JevAsker,
  settings: JevHookSettings = {},
): Promise<JevCompactionOutcome> {
  const source = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
  const { messages } = mapOmpMessages(source);
  const before = transcriptChars(messages);

  /**
   * The library always pins tool calls in the first message, which is right
   * for a whole conversation but wrong here: omp's region frequently BEGINS
   * with the assistant message that holds every tool call, so that rule pinned
   * the entire region (observed live: calls=1 pinned=1, reduction 0%). A
   * sentinel takes index 0 so the real first message is scoreable, and it is
   * dropped again before rendering.
   */
  const sentinel = { role: 'user' as const, text: '(start of the region being compacted)', toolUses: [] };
  const result = await compact([sentinel, ...messages], asker, {
    goal: settings.goal,
    keepThreshold: settings.keepThreshold ?? DEFAULTS.keepThreshold,
    preserveRecentMessages: settings.preserveRecentMessages ?? DEFAULTS.preserveRecentMessages,
    maxStateTokens: settings.maxStateTokens,
    maxRequestTokens: settings.maxRequestTokens,
    truncateHeadChars: settings.truncateHeadChars,
    allowDroppingCalls: settings.allowDroppingCalls ?? false,
  });
  const keptMessages = result.messages.filter((message) => message !== sentinel);

  const after = transcriptChars(keptMessages);
  const reduction = before === 0 ? 0 : (before - after) / before;

  if (result.stats.calls === 0) return { skipped: 'no-tool-calls', result, reduction };
  const floor = settings.minReductionRatio ?? DEFAULTS.minReductionRatio;
  if (reduction < floor) return { skipped: 'insufficient-reduction', result, reduction };

  const kept = result.stats.kept;
  const dropped = result.stats.resultsDropped + result.stats.callsDropped;
  return {
    result,
    reduction,
    compaction: {
      summary: renderVerbatim(keptMessages),
      shortSummary: `Jev verbatim compaction: kept ${kept} tool calls, dropped ${dropped}, ${Math.round(
        reduction * 100,
      )}% smaller`,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      details: { jev: result.decisions },
      preserveData: {
        jevCompaction: {
          version: 1,
          decisions: result.decisions.length,
          kept,
          dropped,
          reduction,
        },
      },
    },
  };
}

/** Minimal shape of omp's `HookAPI` used here. */
export interface OmpHookApi {
  on(
    event: 'session_before_compact',
    handler: (
      event: { preparation: OmpCompactionPreparation },
      ctx?: { ui?: { notify?: (message: string, level?: string) => void } },
    ) => Promise<{ compaction?: OmpCompactionResult } | undefined>,
  ): void;
  on(
    event: 'context',
    handler: (event: { messages: OmpMessage[] }) => Promise<{ messages?: OmpMessage[] } | undefined>,
  ): void;
  logger?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void };
}

/**
 * omp hook entry point: `omp --hook /path/to/hook.js`.
 *
 * Any failure returns nothing rather than throwing, so a Jev outage or a
 * missing key degrades to omp's own compaction instead of breaking the turn.
 */
export default function hook(pi: OmpHookApi, clientOptions: DualJevClientOptions = {}): void {
  pi.on('session_before_compact', async (event, ctx) => {
    const env = clientOptions.env ?? process.env;
    const settings = { ...settingsFromEnv(env), ...clientOptions } as JevHookSettings & DualJevClientOptions;
    try {
      const client = new DualJevClient({
        env,
        provider: settings.provider,
        apiKey: settings.apiKey,
        model: settings.model,
        baseUrl: settings.baseUrl,
        timeoutMs: settings.timeoutMs,
        fetch: clientOptions.fetch,
      });
      const outcome = await jevCompaction(event.preparation, client, settings);
      const stats = outcome.result?.stats;
      if (!outcome.compaction) {
        pi.logger?.info?.(
          `jev compaction skipped: ${outcome.skipped} ` +
            `(calls=${stats?.calls ?? 0} pinned=${stats?.pinned ?? 0} kept=${stats?.kept ?? 0} ` +
            `resultsDropped=${stats?.resultsDropped ?? 0} callsDropped=${stats?.callsDropped ?? 0} ` +
            `chars=${stats?.charsBefore ?? 0}->${stats?.charsAfter ?? 0} ` +
            `reduction=${(outcome.reduction * 100).toFixed(1)}% requests=${stats?.requests ?? 0})`,
        );
        return undefined;
      }
      ctx?.ui?.notify?.(
        `Jev (${client.provider.name}) kept history verbatim, ${Math.round(outcome.reduction * 100)}% smaller`,
        'info',
      );
      return { compaction: outcome.compaction };
    } catch (error) {
      pi.logger?.warn?.(`jev compaction unavailable: ${(error as Error).message}`);
      return undefined;
    }
  });

  // Continuous path: omp's `context` event replaces the messages for one
  // request only, so scoring there reduces what is sent without destroying
  // session history. This is where verbatim compaction actually belongs;
  // `session_before_compact` only sees a region omp has often already pruned.
  if ((clientOptions.env ?? process.env).OMP_JEV_CONTEXT === '1') {
    let reducer: ContextReducer | undefined;
    pi.on('context', async (event) => {
      const env = clientOptions.env ?? process.env;
      const settings = { ...settingsFromEnv(env), ...clientOptions } as JevHookSettings & DualJevClientOptions;
      try {
        reducer ??= createContextReducer(
          new CachingAsker(
            new DualJevClient({
              env,
              provider: settings.provider,
              apiKey: settings.apiKey,
              model: settings.model,
              baseUrl: settings.baseUrl,
              timeoutMs: settings.timeoutMs,
              fetch: clientOptions.fetch,
            }),
          ),
          {
            ...settings,
            minChars: Number(env.OMP_JEV_MIN_CHARS ?? '') || undefined,
            onStats: (stats) =>
              pi.logger?.info?.(
                `jev context: ${stats.before}->${stats.after} chars, dropped=${stats.dropped}, ` +
                  `asks=${stats.asks}, cacheHits=${stats.cached}`,
              ),
          },
        );
        const messages = await reducer(event.messages);
        return messages ? { messages } : undefined;
      } catch (error) {
        pi.logger?.warn?.(`jev context reduction unavailable: ${(error as Error).message}`);
        return undefined;
      }
    });
  }
}
