# AGENTS.md

Guidance for AI coding agents (and humans) working on this repository. Keep it
short; the README covers what the product does.

## Purpose

Read the session logs Codex CLI and Claude Code already write locally, and show
daily activity, concurrency, and per-session detail. Local-only. Zero setup.

## Commands

```bash
npm install
npm run verify        # lint + typecheck + test + build — run this before finishing
npm test              # vitest
npm run dev           # build the server and run it
npm run dev:web       # Vite dev server against a running API on :7781
node dist/cli/main.js --doctor    # show what auto discovery found
```

## Architecture boundaries

```
core/       normalized model + analysis, incl. the price list. Knows nothing
            about any provider.
adapters/   the ONLY provider-aware code.
discovery/  where logs live. No parsing.
indexer/    scanning, caching, incremental re-reads.
server/     loopback HTTP + SSE.
web/        UI. Reads the normalized model only.
```

Two rules hold the design together:

1. **`core/` and `web/` never import from `adapters/`.** If the UI needs
   something provider-specific, the adapter must normalize it first, or put it
   in `providerMeta`.
2. **Threshold-dependent analysis lives outside adapters.** Adapters emit events
   with timestamps; segments, idle, concurrency and liveness are computed in
   `core/`. This is what lets the idle threshold change without re-reading a
   single log file.
3. **Only `core/pricing.ts` turns tokens into money.** An adapter reports the
   dollars a provider wrote down and nothing else. Estimates live in their own
   fields (`estimatedCostUsd`, `ModelCost.basis`) so they can never be read as
   a measurement, and the price list is user-overridable through
   `config.modelRates`.

## Adding a provider adapter

Implement `ProviderAdapter` (`src/core/types.ts`) and register it in
`src/discovery/roots.ts`. Nothing else should need to change.

- `parseFile` must **never throw**. A truncated final line is normal — the agent
  may be writing right now.
- Return `bytesConsumed` at a **line boundary**, so an append can be resumed.
- Unknown record types are ignored, not fatal. Both CLIs ship weekly.
- Keep everything that does not map cleanly in `providerMeta` rather than
  inventing normalized fields or dropping it.
- Only report `measured.*` and `costUsd` when the provider **actually wrote the
  number down**. Never derive cost from tokens × a price list — `core/pricing.ts`
  does that, from `tokensByModel`, and labels the result as an estimate.
- Fill `tokensByModel` with whatever model the log attributes usage to, and
  `costByModel` only where the provider priced each model itself. Keep the
  `TokenUsage` buckets **disjoint**: `input` is prompt tokens that missed the
  cache, so a provider that reports cached tokens inside its input count must
  subtract them in the adapter.
- If the provider publishes a runtime marker, implement `collectLiveMarkers`.

## Semantics that must not be broken

These are the product, not implementation details:

- **Wall span** is a fact. **Active time** is an estimate and a **lower bound**.
  They are different columns and must never be conflated.
- **Clock time** (union of active intervals) and **agent time** (sum of them)
  are different numbers. Never add, average, or substitute one for the other.
- **Measured vs estimated** is always visible in the UI (`measured` / `est.`
  badges). Never present an estimate as a measurement.
- **A session's cost is measured or estimated, never both.** If the provider
  priced the session, its figure stands and nothing is estimated on top; a
  total that is part fact and part guess is what the cost columns exist to
  prevent.
- **A ratio with no denominator is `n/a`, never `0`.** Cost per task on a day
  with no prompts is not zero — a zero there averages into a budget.
- A model with usage but no known rate is reported as **unpriced** and excluded
  from totals. It is never counted as free.
- A metric a provider does not record renders as **"not recorded"**, never `0`.
- **Liveness always carries evidence and a confidence level.** Never assert that
  a session is running.
- Days are bucketed in the **viewer's local timezone**, and an interval crossing
  midnight is **split** between both days.
- Subagent transcripts are **separate sessions** linked to a parent. Collapsing
  them into the parent silently deletes real concurrent work.

## Privacy and security invariants

Violating any of these is a release blocker:

- **No outbound network requests. Ever.** No telemetry, no analytics, no update
  checks. `dependencies` in `package.json` must stay **empty**.
- The HTTP server binds to `127.0.0.1` only, rejects non-loopback `Host`
  headers, and rejects cross-origin requests. Do not add CORS.
- Provider directories are **read-only**. This app writes only to
  `~/.agent-session-observer/`.
- Never scan a home directory recursively; scan known provider subdirectories at
  bounded depth, and **never follow symlinks or junctions**.
- Never start a WSL distribution as a side effect. Default to running
  distributions only.
- Prompt text may be displayed locally; it must never be logged to stdout,
  written outside the cache, or sent anywhere.

## Look and feel

The UI is an instrument panel, not a web page: a fixed icon rail, hairline
rules, and readouts in monospace. Three rules keep it coherent.

- **Monospace carries every label, number and control**; the proportional face
  is only for prose the user wrote and for explanatory notes. There are no web
  fonts — the app makes no outbound requests — so this split is where the
  interface gets its character.
- **One signal colour.** Amber means *live, selected, or measured*. Mint is
  Codex and violet is Claude Code, everywhere, so any chart identifies its
  provider without a legend. Adding a fourth hue needs a reason.
- **Colours are tokens in `web/src/styles.css`**, defined once for light and
  swapped for dark. Components may use `var(--…)` inline; they must not contain
  literal colours.

The application mark is generated: `scripts/icon-spec.mjs` is the single source
for the favicon and the Windows executable icon, and `npm run icons` rebuilds
both. Do not hand-edit `web/public/favicon.svg`.

## Interface language

The UI ships English and Japanese. `web/src/lib/messages.ts` holds both tables
and is deliberately free of React and of the DOM, so the test suite can import
it directly.

- English is the source of truth; every key must exist in both tables with the
  same `{placeholders}`. `test/i18n.test.ts` enforces this, so a half-translated
  string fails the build rather than appearing mid-sentence in the wrong
  language.
- Never concatenate translated fragments; add a key with placeholders instead.
- Product names (Codex, Claude Code), normalized event kinds, and cost in USD
  stay untranslated — they are identifiers, not prose.
- CLI and server output stay English.

## Testing expectations

- Every parser change needs a fixture. **Fixtures are 100% synthetic** — no real
  prompt, path, username, repository, email or credential, ever.
- When a provider changes format, **add** a fixture; do not edit the old one.
  The previous shape still has to parse.
- Analysis changes need a test that pins the semantics above, not just the
  arithmetic.
- Tests must not depend on Codex or Claude Code being installed. Pin
  `discovery: { homeDir, platform, env }` and use `extraRoots`.
- `npm run verify` must pass before you call anything done.
