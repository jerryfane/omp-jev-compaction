import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJevResponse } from './vendor/fast-jev/request.js';
import type { JevAsker, JevQuestions, JevResponse, JevState } from './vendor/fast-jev/types.js';

/** Where a Jev decision request is sent. */
export type JevProviderName = 'typesafe' | 'openrouter';

export interface JevProvider {
  readonly name: JevProviderName;
  readonly url: string;
  readonly model: string;
  /**
   * Absent when a relay in front of the endpoint adds the key itself (a
   * keyring relay, for instance): no Authorization header is sent then.
   */
  readonly apiKey?: string;
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
  /** omp's models file; defaults to `$HOME/.omp/agent/models.yml`. */
  ompModelsFile?: string;
}

/**
 * The Jev decision URL behind omp's own OpenRouter provider, when that
 * provider is a keyless relay (`auth: none`), such as a keyring relay that
 * adds the API key on the way out. Its chat `baseUrl` ends in `/api/v1`; the
 * decision endpoint sits beside it at `/api/alpha/decisions`. Returns nothing
 * for a provider that needs its own key or a URL of any other shape.
 *
 * Only the `providers.openrouter` block is read, line by line, so no YAML
 * dependency is needed for two scalar fields.
 */
export function ompOpenRouterRelayUrl(file: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  // Only `providers.openrouter.baseUrl` and `.auth` count: the openrouter key
  // must sit at the first level under `providers`, and its fields at the
  // first level under it. Deeper keys of the same name (model overrides, a
  // model's own baseUrl) are ignored rather than mistaken for the provider's.
  let inProviders = false;
  let providerIndent = -1;
  let blockIndent = -1;
  let fieldIndent = -1;
  let baseUrl: string | undefined;
  let keyless = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      if (blockIndent >= 0) break;
      inProviders = line.trim() === 'providers:';
      continue;
    }
    if (!inProviders) continue;
    if (providerIndent < 0) providerIndent = indent;
    if (blockIndent < 0) {
      if (indent === providerIndent && line.trim() === 'openrouter:') blockIndent = indent;
      continue;
    }
    if (indent <= blockIndent) break;
    if (fieldIndent < 0) fieldIndent = indent;
    if (indent !== fieldIndent) continue;
    const field = line.trim().match(/^(baseUrl|auth):\s*["']?([^"'\s]+)["']?$/);
    if (field?.[1] === 'baseUrl') baseUrl = field[2];
    if (field?.[1] === 'auth') keyless = field[2] === 'none';
  }
  if (!keyless || !baseUrl || !/\/api\/v1\/?$/.test(baseUrl)) return undefined;
  return baseUrl.replace(/\/v1\/?$/, '/alpha/decisions');
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
  const keyed =
    options.provider ?? (options.apiKey ? 'typesafe' : typesafeKey ? 'typesafe' : openrouterKey ? 'openrouter' : undefined);
  const apiKey = options.apiKey?.trim() || (keyed === 'typesafe' ? typesafeKey : keyed === 'openrouter' ? openrouterKey : undefined);

  if (!apiKey) {
    // No key here. An explicit endpoint, or omp's own keyless OpenRouter
    // relay, is trusted to add it: the key never enters this process.
    const modelsFile = options.ompModelsFile ?? (env.HOME ? join(env.HOME, '.omp', 'agent', 'models.yml') : undefined);
    const relay = options.baseUrl ?? (keyed !== 'typesafe' && modelsFile ? ompOpenRouterRelayUrl(modelsFile) : undefined);
    if (relay) {
      const name = keyed ?? 'openrouter';
      return { name, url: relay, model: options.model ?? (name === 'typesafe' ? TYPESAFE_MODEL : OPENROUTER_MODEL) };
    }
    throw new Error(
      keyed
        ? `Jev provider "${keyed}" selected but its API key is not set, and no relay endpoint is configured.`
        : 'No Jev credential: set TYPESAFE_API_KEY or OPENROUTER_API_KEY, set OMP_JEV_BASE_URL to a relay that adds the key, ' +
            "or give omp's OpenRouter provider a keyless relay (auth: none) in ~/.omp/agent/models.yml.",
    );
  }
  const wanted = keyed as JevProviderName;

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
          ...(this.provider.apiKey ? { authorization: `Bearer ${this.provider.apiKey}` } : {}),
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
