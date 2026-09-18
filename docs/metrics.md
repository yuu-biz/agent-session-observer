# How the numbers are computed

Every figure in the dashboard is one of three things, and the UI always says
which:

- **fact** — read directly out of the log
- **measured** — a number the provider itself timed and wrote down
- **estimate** — derived by this tool from event timestamps

This document defines each one precisely, so that nobody has to guess.

## The raw material

Both Codex CLI and Claude Code append one JSON object per line to a session log,
each carrying a timestamp. That gives a sequence of *instants*, not a continuous
"the agent is busy" signal. Everything below is built from those instants.

## Per-session

### Wall span — *fact*

```
wallSpan = lastEvent.ts - firstEvent.ts
```

The time between the first and last recorded event. It says nothing about how
much of that time anything was happening.

### Activity segments — *estimate*

Sort the event timestamps. Walk them, and start a new **segment** whenever the
gap to the next event exceeds the **idle threshold** (default 5 minutes,
configurable). A segment runs from its first to its last event.

```
gap > idleThreshold   →  split
gap == idleThreshold  →  continuous
```

### Active time — *estimate, lower bound*

```
active = Σ (segment.end - segment.start)
```

This deliberately **under**-counts: a segment ends at its final event, so work
performed after that event is not counted. Erring low is the honest direction —
a dashboard that inflates working time is worse than one that trims it.

It is **not** model compute time. A session can be active for an hour while the
model ran for ninety seconds.

### Idle time — *estimate*

```
idle = wallSpan - active
```

The individual gaps longer than the threshold are listed on the session page, so
you can see whether "idle" was lunch or a single long-running build.

### Effect of the idle threshold

Raising the threshold folds short pauses into work, so `active` rises and `idle`
falls. The function is monotone: a larger threshold never produces less active
time. Changing it recomputes everything instantly — no log is re-read, because
threshold-dependent analysis lives outside the parsers.

## Per-day

Days are bucketed in the **viewer's local timezone**, and an interval that
crosses local midnight is **split** between the two days rather than being
assigned wholesale to one. Day lengths are derived from real local midnights, so
23-hour and 25-hour DST days bucket correctly.

### Clock time active vs agent time — *both estimates*

Given every session's segments for the day:

| | Definition |
| --- | --- |
| **Clock time active** | length of the **union** of all segments |
| **Agent time** | **sum** of all segment lengths |

Three agents working 09:00–10:00 produce **1 hour** of clock time and **3 hours**
of agent time. Mixing these up is the single easiest way to make an agent
dashboard lie, so they are always shown as separate numbers and never added.

### Concurrency — *estimate*

A sweep line over all segment endpoints, treating intervals as half-open
`[start, end)` so that two touching sessions do not register as overlapping.

| | Definition |
| --- | --- |
| **Peak concurrency** | the highest number of sessions active at one instant |
| **Time at level *n*** | wall-clock time with exactly *n* sessions active |
| **Average concurrency** | `agentTime / clockTime` — the mean number of agents running *while anything was running*, not averaged over the idle parts of the day |

The per-level times always sum exactly to the clock time active.

### What lands on which day

Interval-shaped quantities (segments, wall spans) are **split** across days.
Per-session counters and totals (prompts, tool calls, tokens, cost) are
attributed to the day the session **started**, so they still add up to the
session's own totals rather than being double counted.

## Subagents

A subagent transcript is treated as its **own session**, linked to its parent.
Folding it into the parent would silently delete real concurrent work: when a
Claude Code session fans out to five subagents, six agents really were running.
Because clock time is a union, the parent's overlapping activity is not double
counted; agent time does add, which is the intended meaning.

## Measured values

These come straight from the provider and are never mixed with the estimates
above.

| Value | Codex CLI | Claude Code |
| --- | --- | --- |
| Model / API duration | sum of `task_complete.duration_ms` | `cost-state.totalAPIDuration` |
| Time to first token | `task_complete.time_to_first_token_ms` | not recorded |
| Tool execution time | per call, from item timings and tool output metadata | `cost-state.totalToolDuration` (session total) |
| Tokens | `token_usage_record.usage` | per-message `message.usage` |
| Cost in USD | **not recorded** | `cost-state.totalCostUSD` — the same number `/cost` prints |
| Lines added / removed | not recorded | `cost-state.totalLinesAdded` / `Removed` |

Where a provider records nothing, the UI shows **"not recorded"**. It never
shows `0`, and it never estimates cost by multiplying tokens by a price list.

## Liveness

A log cannot prove a process is alive, so every verdict carries its evidence and
a confidence level.

| Status | Meaning |
| --- | --- |
| **Active** | a runtime marker reports `busy` with a fresh heartbeat, or the log was written within ~90 s |
| **Recently active** | activity within ~5 minutes |
| **Likely idle** | a live process that has not written for a while |
| **Ended** | no recent activity, or the recorded pid is gone |

Claude Code writes `~/.claude/sessions/<pid>.json` with a `busy`/`idle` status
and a heartbeat, so its verdicts reach **high** confidence; a marker whose pid no
longer exists is strong evidence the session ended. Codex publishes no such
marker, so its sessions are graded from log recency alone and are capped at
**medium** confidence.
