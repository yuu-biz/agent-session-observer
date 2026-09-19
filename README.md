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
- **What does one task cost** — in dollars, in agent time, in tokens — and which
  model is the bill actually coming from?

## Install

### Download a build (no Node required)

Grab the archive for your platform from
[**Releases**](https://github.com/yuu-biz/agent-session-observer/releases/latest),
unpack it, and run it:

| Platform | Archive | Run |
| --- | --- | --- |
| Windows | `agent-session-observer-windows-x64.zip` | `agent-session-observer.exe` |
| macOS (Apple silicon) | `agent-session-observer-macos-arm64.tar.gz` | `./agent-session-observer` |
| Linux | `agent-session-observer-linux-x64.tar.gz` | `./agent-session-observer` |

**One file, double-click, done.** The Node runtime and the whole dashboard are
embedded in the binary, and on Windows it carries no console window — it just
opens as an app. There is no shortcut to edit and no flag to remember. Drop it
anywhere and move it around freely; nothing sits beside it to keep in sync.

Each archive ships a `.sha256`. On macOS the binary is ad-hoc signed, so
Gatekeeper will ask you to approve it the first time.

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
agent-session-observer --tab         # a normal browser tab instead of an app window
agent-session-observer --doctor      # print what was auto-discovered, then exit
agent-session-observer --port 8080   # use a different port
agent-session-observer --no-open     # start the server without opening anything
agent-session-observer --wsl off     # skip WSL scanning entirely
```

> Running from source? Use `node dist/cli/main.js <flags>`.
>
> The packaged Windows build has no console, so command-line output only appears
> when you redirect it: `agent-session-observer --doctor > report.txt`. The
> **Sources** screen shows the same information.

### How the app window works

There is no second browser engine in the download. The app window is the
Chromium-based browser you already have (Edge, Chrome, Brave, Vivaldi,
Chromium) opened in app mode:

- a window with **no tab strip and no address bar**;
- **closing the window quits the app**, server included — or use **quit** in the
  top bar;
- its own browser profile under `~/.agent-session-observer/`, which keeps it out
  of the way of your normal browsing and is what lets the app notice the window
  closing.

Launching it again while it is already running opens another window onto the
instance you have, rather than failing on a busy port.

If no Chromium-based browser is found it falls back to a normal tab and says so.
On Windows Edge is always present, so this is effectively guaranteed; on macOS
Safari cannot do app mode, so install one of the above for the windowed
experience.

### Language

English and Japanese, switched from the top bar. The first run follows your
browser's language; after that the choice is remembered locally.

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
| **Task** | one user prompt and the work that followed it, up to the next prompt | fact |
| **Estimated cost** | token counts × a price list, for the sessions no provider priced | **estimate** |

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

## Cost and unit economics

Totals answer "what did we spend". The **Cost** screen answers the question
people are usually really asking: *what does a unit of work cost, and is that
number moving?*

The unit is a **task** — one user prompt and the work that followed it, up to
the next prompt. It needs no configuration, both CLIs record it the same way,
and it is the closest thing in a session log to "a thing someone asked for".

| Metric | Why it is on the screen |
| --- | --- |
| **Cost per task** | The number to compare across weeks, teams or tools. A total only tells you that usage went up. |
| **Cost per session / per agent-hour / per 1M tokens** | Three different denominators, because a long cheap session and a short expensive one are different problems. |
| **Active time per task** | Work, not elapsed time: idle gaps are already excluded. |
| **Wall-clock per task** | The same work with parallel sessions collapsed — pair it with the one above to see the leverage. |
| **Parallel leverage** | Agent-hours delivered per wall-clock hour. `1.0×` means strictly serial. |
| **Cache hit rate and cache savings** | Usually the largest single lever on the bill, and invisible in a plain token count. |
| **Tool calls / tokens / errors per task** | Whether a task is getting more expensive because it is bigger, or because it is retrying. |
| **Per model and per provider** | Where the money is, with each row labelled measured or estimated. |

A metric with no denominator reads **n/a**, never `0.00`: a zero here averages
straight into somebody's budget.

### Measured, estimated, and never both

Claude Code writes its own dollar figure into the log. Codex writes none at all.
Leaving the Codex column blank made the cheaper-looking provider the one that
simply says less — so this tool estimates it, and says so everywhere:

- A session the provider priced is **measured**. Its figures are used verbatim
  and nothing is estimated on top of them.
- A session the provider did not price is **estimated**: token counts × a public
  list price, marked with `est.` and a `~` in front of the number.
- The two are summed only where the screen says *measured + estimated*, and the
  split is always shown.
- A model with usage but **no known rate** is reported as `no price` and left
  out of every total — never counted as free.

The bundled list prices are checked against a date shown on the screen, and they
are the wrong number for most organisations. Override them:

```jsonc
// ~/.agent-session-observer/config.json
{
  "modelRates": {
    "gpt-5-codex":   { "input": 0.95, "output": 7.50 },
    "claude-opus-5": { "input": 4.00, "output": 20.00, "cacheRead": 0.40, "cacheWrite": 5.00 }
  }
}
```

Prices are USD per 1,000,000 tokens. The key is matched against the model id the
way the built-in table is, so `"gpt-5"` reprices a whole family and
`"gpt-5-codex"` reprices one model. The Cost screen prints the rates it actually
applied, so there is never a dollar figure on screen whose derivation is hidden.

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
| **Cost in USD** | ❌ never recorded — **estimated** from tokens × a price list | ✅ `cost-state.totalCostUSD` (the same value `/cost` prints) |
| **Cost per model** | ❌ — estimated per model from `turn_context.model` | ✅ `cost-state.modelUsage[*].costUSD` |
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
  core/        normalized session model, activity/idle, concurrency, aggregation,
               pricing and unit economics
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

A price list is analysis, not parsing, so it lives in `core/pricing.ts` and
never in an adapter: an adapter reports only what the provider wrote down, and
nothing else in the app is allowed to turn tokens into money.

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
| `npm run package:sea` | build the self-contained executable for the current platform |
| `npm run icons` | regenerate `web/public/favicon.svg` and the Windows `.ico` from `scripts/icon-spec.mjs` |

All test fixtures are synthetic. No real prompt, path, username, repository or
credential is committed — see [`test/fixtures/README.md`](test/fixtures/README.md).

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) and
[AGENTS.md](AGENTS.md) (which also applies to humans).

## Known limitations

- **Codex liveness is a guess.** Without a runtime marker the best available
  evidence is "the log was written recently".
- **Active time is a lower bound**, and depends on the idle threshold. It is not
  model compute time.
- **Codex cost is an estimate, and so is anything divided by it.** Codex never
  writes a monetary figure, so its dollars are token counts × a list price. List
  prices go stale and ignore whatever your organisation actually pays — set
  `modelRates` in the config before quoting a number to anyone.
- **A "task" is a prompt, not a unit of value.** "Fix the typo" and "port the
  service to gRPC" are both one task. Per-task figures are for comparing a team
  against itself over time, not for comparing two teams.
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
