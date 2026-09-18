# Agent Session Observer

[![CI](https://github.com/yuu-biz/agent-session-observer/actions/workflows/ci.yml/badge.svg)](https://github.com/yuu-biz/agent-session-observer/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/yuu-biz/agent-session-observer)](https://github.com/yuu-biz/agent-session-observer/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Local-only observability for **Codex CLI** and **Claude Code**.

It finds the session logs those tools already write on your machine, and turns
them into a picture of how you actually worked: when you were working, how long
agents were running, how many ran at once, and what happened inside each
session.

No configuration to get started. No account. No network.

---

## What it answers

- How much did I use AI coding agents today, and on which days?
- From what time to what time was I actually working?
- How much of that was agents working, and how much was me thinking?
- Codex or Claude Code — which, and how much of each?
- How many sessions ran **at the same time**, and when did that peak?
- What happened inside one session: prompts, tool calls, tests, commits, errors?
- What might still be running right now?

## Install

### Download a build (no Node required)

Grab the archive for your platform from
[**Releases**](https://github.com/yuu-biz/agent-session-observer/releases/latest),
unpack it, and run the binary next to its `dist/` folder:

| Platform | Archive | Run |
| --- | --- | --- |
| Windows | `agent-session-observer-windows-x64.zip` | `agent-session-observer.exe` |
| macOS (Apple silicon) | `agent-session-observer-macos-arm64.tar.gz` | `./agent-session-observer` |
| Linux | `agent-session-observer-linux-x64.tar.gz` | `./agent-session-observer` |

Each archive ships a `.sha256` next to it. On macOS the binary is ad-hoc signed,
so Gatekeeper will ask you to approve it the first time.

### From source

Requires **Node.js 20.11+**, and nothing else — there are no runtime
dependencies to install.

```bash
git clone https://github.com/yuu-biz/agent-session-observer.git
cd agent-session-observer
npm install
npm run build
npm start
```

Either way it starts a local server on `http://127.0.0.1:7781` and opens your
browser.

```
agent-session-observer --doctor      # print what was auto-discovered, then exit
agent-session-observer --port 8080   # use a different port
agent-session-observer --no-open     # don't launch a browser
agent-session-observer --wsl off     # skip WSL scanning entirely
```

> Running from source? Use `node dist/cli/main.js <flags>`.

## Auto discovery

Nothing to configure. On startup it looks, in order, at:

| Source | Location |
| --- | --- |
| Environment overrides | `CODEX_HOME`, `CLAUDE_CONFIG_DIR` |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, `~/.codex/archived_sessions/` |
| Claude Code | `~/.claude/projects/<project>/<session>.jsonl` and its `subagents/` |
| Claude Code (live) | `~/.claude/sessions/<pid>.json` |
| WSL (Windows host) | the same paths inside each **running** distribution, via `\\wsl.localhost\<distro>\home\<user>\` |
| macOS | `~/.codex` / `~/.claude`, plus `~/Library/Application Support/` as a fallback probe |

Whatever it found — and what it deliberately skipped — is listed on the
**Sources** screen. If your logs live somewhere unusual, add the directory
there; that is the only situation in which configuration is needed.

### About WSL

Reading a path inside a **stopped** WSL distribution boots it. Starting
someone's distro as a side effect of opening a dashboard is not acceptable, so
by default only distributions that are **already running** are inspected, and
the rest are listed as skipped. `--wsl all` opts into scanning everything, at
the cost of starting stopped distributions.

## Reading the numbers

This is the part most agent dashboards get wrong, so it is worth being precise.

| Term | Meaning | Kind |
| --- | --- | --- |
| **Wall span** | last event − first event in the session log | fact |
| **Active** | sum of *activity segments*: runs of events with no gap longer than the idle threshold | **estimate**, lower bound |
| **Idle** | wall span − active | estimate |
| **Clock time active** | wall-clock time during which **at least one** session was active (the union) | estimate |
| **Agent time** | the **sum** of every session's active time (three agents for an hour = three agent-hours) | estimate |
| **Peak concurrency** | the highest number of sessions active at the same instant | estimate |
| **Avg concurrency** | agent time ÷ clock time — the mean number of agents running *while anything was running* | estimate |
| **API time / tool time / cost** | numbers the provider itself measured and wrote into its log | **measured** |

Three things this tool will never tell you:

1. **A two-hour session is not two hours of inference.** Active time is derived
   from how densely events appear in a log, not from model compute.
2. **Active time is a lower bound.** A segment ends at its last event, so work
   done after that final event is not counted.
3. **Estimates are labelled.** Every estimated figure carries an `est.` badge;
   provider-measured figures carry `measured`. The two are never added together.

The **idle threshold** (default 5 minutes) is what separates "still working"
from "went for coffee". Change it on the Sources screen; every derived number
follows it immediately, with no re-reading of logs.

## What each provider records

Not every metric exists in every log. Where a provider records nothing, the UI
says *not recorded* — never `0`.

| Metric | Codex CLI | Claude Code |
| --- | --- | --- |
| Prompts, tool calls, models | ✅ | ✅ |
| Token usage | ✅ `token_usage_record` | ✅ per-message `usage` |
| Per-turn model duration | ✅ `task_complete.duration_ms` | ✅ `cost-state.totalAPIDuration` |
| Time to first token | ✅ | ❌ |
| Tool execution time | ✅ per tool call | ✅ session total only |
| **Cost in USD** | ❌ never recorded | ✅ `cost-state.totalCostUSD` (the same value `/cost` prints) |
| Lines added / removed | ❌ | ✅ |
| **Live session marker** | ❌ — liveness is inferred from log recency alone | ✅ `sessions/<pid>.json` with a `busy`/`idle` heartbeat |

## Is it running right now?

A log file cannot prove a process is alive, so this tool never claims it can.
Sessions are graded, with the evidence shown next to the verdict:

- **Active** — a live runtime marker says so, or the log was written seconds ago
- **Recently active** — activity within the last few minutes
- **Likely idle** — a live process that has not written for a while
- **Ended** — no recent activity, or the recorded pid is gone

Claude Code publishes a per-session marker, so its verdicts reach *high*
confidence. Codex does not, so its sessions are graded from log recency alone
and are marked *low*/*medium* confidence accordingly.

## Privacy

Everything stays on your machine.

- **No telemetry, no analytics, no update checks, no outbound requests of any kind.**
- **Zero runtime dependencies.** The server is Node's standard library only.
- The server binds to `127.0.0.1`, rejects non-loopback `Host` headers (which is
  what stops DNS rebinding), and rejects cross-origin requests.
- Provider directories are opened **read-only** and never modified.
- The first run does not scan your home directory recursively — only known
  provider subdirectories, at bounded depth, never following symlinks.
- Prompt text is rendered in the UI because it is your own content on your own
  machine. It is not transmitted anywhere.
- A parse cache lives in `~/.agent-session-observer/`. Deleting it is always safe.

See [SECURITY.md](SECURITY.md).

## Architecture

```
src/
  core/        normalized session model, activity/idle, concurrency, aggregation
  adapters/    codex/, claude-code/   — the only provider-aware code
  discovery/   filesystem scanning, WSL enumeration, root resolution
  indexer/     incremental scanner + on-disk parse cache
  server/      loopback HTTP API, SSE
  cli/         entry point
web/           React dashboard; reads the normalized model only
```

The boundary that matters: **the UI and all analysis see only the normalized
model.** Adding a provider means writing one adapter — it never requires
touching `core/` or `web/`. Adapters keep both normalized fields and a
`providerMeta` bag, so provider-specific detail is preserved rather than
flattened away.

Live updates use polling rather than filesystem watchers: `fs.watch` is
unreliable over UNC and WSL paths and behaves differently on each platform,
whereas a cheap stat-based rescan behaves identically everywhere. Logs are
append-only, so a growing file is resumed from its last complete line instead of
being re-read.

## Development

```bash
npm install
npm run verify          # lint + typecheck + test + build
npm run dev             # build the server and run it
npm run dev:web         # Vite dev server against a running API
```

| Script | |
| --- | --- |
| `npm test` | Vitest, 150+ tests over synthetic fixtures |
| `npm run typecheck` | `tsc --noEmit` for both the server and the web app |
| `npm run lint` | ESLint (flat config) |
| `npm run build` | compile the server and bundle the UI into `dist/` |
| `npm run package:sea` | build the standalone executable for the current platform |

All test fixtures are synthetic. No real prompt, path, username, repository or
credential is committed — see [`test/fixtures/README.md`](test/fixtures/README.md).

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) and
[AGENTS.md](AGENTS.md) (which also applies to humans).

## Known limitations

- **Codex liveness is a guess.** Without a runtime marker the best available
  evidence is "the log was written recently".
- **Active time is a lower bound**, and depends on the idle threshold. It is not
  model compute time.
- **Cost is Claude Code only.** Codex never writes a monetary figure, and this
  tool will not invent one by multiplying tokens by a price list.
- **WSL distributions that are stopped are not scanned** by default, by design.
- **macOS is desk-validated.** The paths and behaviour follow the documented
  layout and are covered by unit tests, but the author has no macOS machine to
  test on. Reports welcome.
- **Log formats will change.** Both CLIs ship frequently. Unknown record types
  are ignored rather than fatal, but a large format change needs an adapter
  update.
- Sessions are bucketed into days by your **local** timezone, and a session that
  crosses midnight is split across both days.
- **Not published to npm yet.** Install from a Release archive or from source.

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with OpenAI or Anthropic. "Codex" and "Claude Code" are their
respective owners' products; this tool only reads files they write locally.
