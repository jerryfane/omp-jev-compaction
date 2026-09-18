# omp-jev-compaction

Verbatim context reduction for [omp](https://github.com/jerryfane/oh-my-pi), scored by
TypeSafe's Jev decision model, over **either** the TypeSafe API **or** OpenRouter.

Nothing is rewritten or summarized. Every tool call and tool result is scored;
the ones Jev says are no longer needed are truncated to a short head plus a
recoverable note, and everything else, including all user and assistant text,
is passed through exactly as omp built it.

## Why a separate package

The scoring core comes from [`fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction)
(MIT), vendored under `src/vendor/fast-jev/` at commit `e3f262a` — it is not
published to npm, and its own hook half targets Claude Code's plugin API
(`import type { Register, SessionMessage } from 'claude-code'`), which omp
cannot load. This package supplies the omp side: provider selection, message
mapping, the two integration points, and the tests.

Re-sync the vendored core by copying `src/{compact,state,types,request}.ts`
from upstream and updating `src/vendor/fast-jev/UPSTREAM_COMMIT`.

## One caution before fleet-wide use

Every reduction sends the conversation state (tool names, inputs, and message
text; tool *outputs* are replaced by size notes first) to the decision
endpoint. On a shared machine that is one more place your work travels to.
Cost is negligible, about $0.0005 per pass, and decisions are cached.

## Providers

| Provider | Endpoint | Model | Key |
|---|---|---|---|
| TypeSafe | `POST https://api.typesafe.ai/v1/systemone` | `jev-latest` | `TYPESAFE_API_KEY` |
| OpenRouter | `POST https://openrouter.ai/api/alpha/decisions` | `typesafe/jev-1.13` | `OPENROUTER_API_KEY` |

Both take the identical `{model, state, questions}` body and return `noul`
probabilities, so one client covers both. `TYPESAFE_API_KEY` wins when both are
set; `OMP_JEV_PROVIDER` forces one. OpenRouter's path is explicitly alpha
upstream and may move — `OMP_JEV_BASE_URL` overrides it without a code change.

Measured on OpenRouter: ~430 ms per decision request, $0.0000198 for 472 input
tokens.

## Install

As an omp plugin, which is one command and needs no flags afterwards:

```sh
omp plugin install jerryfane/omp-jev-compaction     # or a local path
omp                                                  # that is all
```

Installing is the opt-in, so continuous reduction is **on by default** with
threshold `0.2`, a 150,000-character floor and payload parking enabled. No
environment variables are needed. Turn it off again with `OMP_JEV_CONTEXT=0`
or `omp plugin disable omp-jev-compaction`.

`npm` runs `prepare`, so a git install builds `dist/` itself. Verify with
`omp plugin list`, and confirm it is working with:

```sh
grep "jev context" ~/.omp/logs/omp.$(date +%F).*.log | tail -3
# jev context: 33906->27067 chars, dropped=5, asks=4, cacheHits=20
```

For a single directory instead of everywhere, drop a file at
`.omp/hooks/pre/jev.ts` that calls the hook with `{ context: true }`.

The manifest declares settings with environment fallbacks. Values are read
from the environment today; reading omp's own plugin settings store is not
wired up yet.

## Dropped output is recoverable

A dropped payload is written to `~/.omp/jev-spill/<hash>.txt` and the
replacement text names that file, so the agent gets it back with one `read`
instead of re-running the tool. Identical payloads share one file.

This matters because reduction does lose facts. Measured with
`scripts/recall.ts`: full context answered **100%** of planted questions,
reduced context **63-75%**. With parking on, the misses are **recoverable: 0
permanent losses** across both thresholds tested. Switch it off with
`OMP_JEV_SPILL=0` and the misses become permanent.

## The two integration points

### `context` — continuous reduction (recommended)

Set `OMP_JEV_CONTEXT=1`. omp's `context` event replaces the messages of a
**single request**, so the session on disk is untouched and a wrong judgement
costs one turn instead of destroying history. Decisions are cached per tool
call id, so only newly seen calls reach the provider.

Measured in a live omp session: `11726 -> 400 chars, dropped=16, asks=14,
cacheHits=230`, with the task still answered correctly.

### `session_before_compact` — replaces the compaction summary

Always registered. When omp decides to compact, the region it is about to
discard is scored and returned as verbatim retained history instead of a
written summary.

**Know this before relying on it:** omp prunes tool output *before* this hook
runs. In live sessions the region handed over was usually already reduced by
omp's own `shake` to markers like `[shaken ~516 tokens — recover: artifact://6]`
(55 chars each), or held no tool calls at all. The hook then declines and omp
compacts normally. It is useful only when raw results survive into the region,
so the continuous `context` path is the one that pays.

## Settings

All optional, read from the environment.

| Variable | Default | Meaning |
|---|---|---|
| `OMP_JEV_CONTEXT` | **on** | `0` disables continuous per-request reduction |
| `OMP_JEV_MIN_CHARS` | `150000` | Only reduce a context at least this large |
| `OMP_JEV_PROVIDER` | auto | `typesafe` or `openrouter` |
| `OMP_JEV_MODEL` | per provider | Model id override |
| `OMP_JEV_BASE_URL` | per provider | Endpoint override |
| `OMP_JEV_KEEP_THRESHOLD` | `0.2` | Minimum probability for a call or result to stay |
| `OMP_JEV_ALLOW_DROPPING_CALLS` | off | `1` lets a low score erase the whole call, not just its output |
| `OMP_JEV_PRESERVE_RECENT` | `0` for compaction, `6` for context | Newest messages never touched |
| `OMP_JEV_MIN_REDUCTION` | `0.25` | Saving required before replacing omp's compaction |
| `OMP_JEV_TIMEOUT_MS` | `10000` | Per-request timeout |

`keepThreshold` is the dial that matters, but **safe mode makes it hard to
misuse**: by default a low score can only remove a tool's *output*, never the
record that the call happened. Erasing the call erases the evidence the work
was done, so the agent can repeat it or contradict itself.

Because of that, saving plateaus instead of running away. Measured on two real
sessions, thresholds 0.3, 0.5 and 0.7 produce byte-identical output at 53.6%
and 55% reduction, while the old behaviour reached 96% by deleting 63 of 66
steps. At `0.2`, where Jev is genuinely selective, both modes are within 0.4
points, so the safety is nearly free.

## Failure behaviour

Every path degrades instead of breaking a turn: a missing key, a provider
outage, a timeout or a malformed answer is logged and the handler returns
nothing, leaving omp's own compaction and context in place.

## Two adapter details worth keeping

- omp's assistant tool-call part is `{type:'toolCall', id, name, arguments}`,
  while its tool **result** is a separate `role:'toolResult'` message with
  `toolCallId`/`toolName`. Mapping the wrong names produced a live
  `use.tool.length` crash before this was fixed against omp's real types.
- The scoring core always pins tool calls in the first message. omp's
  compaction region frequently *begins* with the assistant message holding
  every tool call, so that rule pinned the whole region (`calls=1 pinned=1`,
  0% reduction). A sentinel message takes index 0 and is dropped again before
  rendering.

## Tests

```sh
npm test                 # 22 tests, fake provider, offline and deterministic
npm run test:live        # real decision endpoint, needs a key
```

The live suite asserts a genuinely stale 40k-char read is dropped while every
word of user text survives.

## Licence

MIT, as is the vendored upstream core.
