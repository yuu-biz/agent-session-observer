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
core/       normalized model + analysis. Knows nothing about any provider.
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
  number down**. Never derive cost from tokens × a price list.
- If the provider publishes a runtime marker, implement `collectLiveMarkers`.

## Semantics that must not be broken

These are the product, not implementation details:

- **Wall span** is a fact. **Active time** is an estimate and a **lower bound**.
  They are different columns and must never be conflated.
- **Clock time** (union of active intervals) and **agent time** (sum of them)
  are different numbers. Never add, average, or substitute one for the other.
- **Measured vs estimated** is always visible in the UI (`measured` / `est.`
  badges). Never present an estimate as a measurement.
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
