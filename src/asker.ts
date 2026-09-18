import { parseJevResponse } from './vendor/fast-jev/request.js';
import type { JevAsker, JevQuestions, JevResponse, JevState } from './vendor/fast-jev/types.js';

/** Where a Jev decision request is sent. */
export type JevProviderName = 'typesafe' | 'openrouter';

export interface JevProvider {
  readonly name: JevProviderName;
  readonly url: string;
  readonly model: string;
  readonly apiKey: string;
}

/** TypeSafe's own System One endpoint. */
export const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';
export const TYPESAFE_MODEL = 'jev-latest';

/**
 * OpenRouter serves the same `{model, state, questions}` decision body on an
 * alpha path, so one extra URL covers it rather than a second client. The path
 * is explicitly alpha upstream and may move; `baseUrl` overrides it.
 */
export const OPENROUTER_URL = 'https://openrouter.ai/api/alpha/decisions';
export const OPENROUTER_MODEL = 'typesafe/jev-1.13';

export interface ResolveProviderOptions {
  /** Force one provider instead of picking by which key exists. */
  provider?: JevProviderName;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  env?: Record<string, string | undefined>;
}

/**
 * Picks the provider from explicit options first, then from the keys present.
 * A TypeSafe key wins over an OpenRouter key: it is the vendor's own endpoint,
 * so it is the narrower, more specific credential of the two.
 */
export function resolveProvider(options: ResolveProviderOptions = {}): JevProvider {
  const env = options.env ?? process.env;
  const typesafeKey = env.TYPESAFE_API_KEY?.trim();
  const openrouterKey = env.OPENROUTER_API_KEY?.trim();
  const wanted =
    options.provider ?? (options.apiKey ? 'typesafe' : typesafeKey ? 'typesafe' : openrouterKey ? 'openrouter' : undefined);

  if (!wanted) {
    throw new Error(
      'No Jev credential: set TYPESAFE_API_KEY or OPENROUTER_API_KEY (or pass apiKey/provider).',
    );
  }

  const apiKey = options.apiKey?.trim() ?? (wanted === 'typesafe' ? typesafeKey : openrouterKey);
  if (!apiKey) throw new Error(`Jev provider "${wanted}" selected but its API key is not set.`);

  return {
    name: wanted,
    url: options.baseUrl ?? (wanted === 'typesafe' ? TYPESAFE_URL : OPENROUTER_URL),
    model: options.model ?? (wanted === 'typesafe' ? TYPESAFE_MODEL : OPENROUTER_MODEL),
    apiKey,
  };
}

export interface DualJevClientOptions extends ResolveProviderOptions {
  fetch?: typeof fetch;
  /** Per-request timeout; the compaction path must not hang a turn. */
  timeoutMs?: number;
}

/** Asks Jev over whichever provider resolved, with the identical request body. */
export class DualJevClient implements JevAsker {
  readonly provider: JevProvider;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: DualJevClientOptions = {}) {
    this.provider = resolveProvider(options);
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(this.provider.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.provider.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: this.provider.model, state, questions }),
        signal: controller.signal,
      });
      return parseJevResponse(response.status, response.ok, await response.text());
    } finally {
      clearTimeout(timer);
    }
  }
}
