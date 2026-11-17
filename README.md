# omp-jev-compaction

**Your coding agent's context fills up with tool output it will never look at again.
This plugin drops it before every request, without rewriting a single word.**

A plugin for [omp](https://github.com/jerryfane/oh-my-pi). Before each model request it asks
[Jev](https://typesafe.ai), TypeSafe's small decision model, which old tool results the agent still
needs. The rest are cut to a short head plus a note saying where the full text was saved. User and
assistant messages are never touched, and nothing is summarized.

```text
before   ┃ user ┃ read 40k ┃ grep 12k ┃ test log 30k ┃ assistant ┃ read 8k ┃ user ┃
after    ┃ user ┃ read 40k ┃ grep  ·  ┃ test log  ·  ┃ assistant ┃ read 8k ┃ user ┃
                             └─ "dropped, saved at ~/.omp/jev-spill/…/1a2b.txt"
```

## Results

From one machine running about 75 coding agents around the clock, across 300 omp process logs
(15–17 Nov 2026):

| | |
|---|---|
| Reductions | 1,016 |
| Context sent to the model | **538 M → 450 M characters (−16%)** |
| Stale tool outputs dropped | 152,211 |
| Plugin errors in those logs | 0 |
| Cost of a decision | ~$0.0005 per pass, ~430 ms per request on OpenRouter |

Savings depend on the session: long sessions full of file reads and logs save the most (53–55% on
two measured sessions), and contexts under 150,000 characters are left alone.

## Install

```sh
omp plugin install jerryfane/omp-jev-compaction
```

That's it. It's on by default after install. Give it a key (or a key relay, see below):

```sh
export OPENROUTER_API_KEY=...     # or TYPESAFE_API_KEY=...
```

Check it's working:

```sh
grep "jev context" ~/.omp/logs/omp.$(date +%F).*.log | tail -3
# jev context: 33906->27067 chars, dropped=5, asks=4, cacheHits=20
```

Turn it off with `OMP_JEV_CONTEXT=0` or `omp plugin disable omp-jev-compaction`.

## Why it's safe to leave on

- **Verbatim, not summarized.** Everything that stays is byte-for-byte what omp built. A summary can
  invent or blur facts; a dropped output can't.
- **Only outputs go, never the record of the work.** By default a low score removes a tool's *result*,
  never the fact that the call happened, so the agent doesn't redo or contradict its own work.
- **Dropped output can be read back.** Each dropped output is saved to
  `~/.omp/jev-spill/<day>/<hash>.txt` and the note names the file, so the agent gets it back with one
  `read`. In recall tests, reduced context answered 63–75% of planted questions directly, and every
  miss was recoverable from the saved file: 0 permanent losses. If saving fails (say, the disk is full),
  the output is still dropped and the note tells the agent to re-run the tool instead. Saved files are
  removed by a best-effort sweep once 14 days have passed after the end of the UTC day they were
  written.
- **Per request, not per session.** Reduction changes what one request sends; the session on disk is
  untouched, so a wrong call costs one turn, not your history.
- **Prompt cache friendly.** Decisions are remembered and re-applied, so the start of the context stays
  byte-identical between rare rewrites. Replaying a real session: 3 rewrites in 40 requests and 0
  cache-prefix breaks.
- **Fails open.** No key, an outage, a timeout or a bad answer is logged, and omp carries on exactly as
  without the plugin.

## Providers

| Provider | Model | Key |
|---|---|---|
| [TypeSafe](https://typesafe.ai) | `jev-latest` | `TYPESAFE_API_KEY` |
| [OpenRouter](https://openrouter.ai) | `~typesafe/jev-latest` | `OPENROUTER_API_KEY` |

Both are rolling aliases, so new Jev releases arrive without a plugin update. `TYPESAFE_API_KEY` wins
when both are set; `OMP_JEV_PROVIDER` forces one.

**No key in the agent's session.** If omp already reaches OpenRouter through a keyless relay that adds
the key on the way out (`auth: none` in `~/.omp/agent/models.yml`), the plugin uses that relay too, with
no extra setting:

```yaml
providers:
  openrouter:
    baseUrl: http://127.0.0.1:7700/agents/openrouter/api/v1
    auth: none
```

**Privacy.** Each decision sends the conversation's shape to the provider: tool names and inputs and
message text. Tool *outputs* are replaced by size notes first.

## Settings

All optional, read from the environment.

| Variable | Default | Meaning |
|---|---|---|
| `OMP_JEV_CONTEXT` | **on** | `0` disables continuous per-request reduction |
| `OMP_JEV_MIN_CHARS` | `150000` | Only reduce a context at least this large |
| `OMP_JEV_KEEP_THRESHOLD` | `0.2` | Minimum probability for a call or result to stay |
| `OMP_JEV_PRESERVE_RECENT` | `0` | Newest messages never touched; set e.g. `6` to always keep the latest few intact |
| `OMP_JEV_SPILL` | on | `0` stops saving dropped outputs (misses become permanent) |
| `OMP_JEV_SPILL_RETENTION_DAYS` | `14` | Days to keep saved outputs; `0` keeps them forever |
| `OMP_JEV_ALLOW_DROPPING_CALLS` | off | `1` lets a low score erase the whole call, not just its output |
| `OMP_JEV_PROVIDER` | auto | `typesafe` or `openrouter` |
| `OMP_JEV_MODEL` | per provider | Pin a specific Jev version |
| `OMP_JEV_BASE_URL` | per provider | Endpoint override, or a relay that adds the key |
| `OMP_JEV_CACHE_CEILING` | `0.8` | Non-sticky mode only: skip sessions at least this share cache reads |
| `OMP_JEV_MIN_REDUCTION` | `0.25` | Saving required before replacing omp's compaction summary |
| `OMP_JEV_TIMEOUT_MS` | `10000` | Per-request timeout |

## How it works

[docs/DESIGN.md](docs/DESIGN.md) covers the details: sticky rewrites and the cache guard, the two omp
integration points (`context` and `session_before_compact`), how relays are detected, the keep
threshold, and the omp adapter details that matter.

## Development

```sh
npm install
npm test               # offline and deterministic, fake provider
npm run test:live      # against the real decision endpoint, needs a key
```

## Credits

- The scoring core is [`fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction) by
  [@tamaratran](https://github.com/tamaratran) (MIT), vendored under `src/vendor/fast-jev/`. This package adds the omp side: providers,
  message mapping, the integration points, saving dropped output, and tests.
- [Jev](https://typesafe.ai) is TypeSafe's decision model.

## Licence

MIT, as is the vendored upstream core.
