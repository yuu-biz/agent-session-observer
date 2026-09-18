# Security

## What this tool touches

Agent Session Observer reads AI coding-agent session logs from your own machine.
Those logs contain **everything you typed into an agent and everything the agent
read** — including, potentially, secrets that a tool call happened to print. The
threat model follows from that: the data is sensitive, and it must not leave the
machine or become reachable by anything else on it.

## Design invariants

These are enforced in code and covered by tests (`test/server.test.ts`,
`test/discovery.test.ts`).

**Network**

- No outbound requests of any kind: no telemetry, no analytics, no update
  checks, no crash reporting, no font or CDN fetches in the UI.
- `dependencies` in `package.json` is **empty**. The server uses only Node's
  standard library, which keeps the runtime supply chain at zero packages.
- The HTTP server binds to `127.0.0.1` — never `0.0.0.0`.
- Requests whose `Host` header is not a loopback name are rejected with `421`.
  This is what prevents **DNS rebinding**: a malicious website cannot resolve a
  hostname to `127.0.0.1` and then read your prompts through your browser.
- Cross-origin requests are rejected with `403`. There is no CORS negotiation to
  get wrong.
- The UI has no configurable API base URL, so it cannot be pointed at a remote
  host.

**Filesystem**

- Provider directories are opened **read-only**. Nothing under `~/.codex` or
  `~/.claude` is created, modified or deleted.
- The only directory written to is `~/.agent-session-observer/` (config and
  parse cache). Deleting it is always safe.
- Scanning is bounded: known provider subdirectories only, fixed maximum depth,
  a cap on entries, and **symlinks and junctions are never followed** — so a
  link into `C:\` or a loop cannot turn a log scan into a whole-disk scan.
- The home directory is never scanned recursively.
- Static requests are normalised before any backend sees them: traversal
  segments, backslashes, drive and UNC prefixes, NUL bytes and undecodable
  escapes are **rejected**, not sanitised. The on-disk backend additionally
  re-checks the resolved path against the asset root.

**Processes**

- WSL distributions are enumerated with `wsl.exe -l -q`, which starts nothing.
  Distributions that are not already running are **not** read, because touching
  `\\wsl.localhost\<distro>\` would boot them. `--wsl all` opts out of that
  protection explicitly.
- The only other process ever launched is the platform's "open a URL" helper
  (`cmd /c start`, `open`, `xdg-open`), and only when you did not pass
  `--no-open`.
- Liveness checks use `process.kill(pid, 0)`, which sends no signal.

**Data handling**

- Prompt text is rendered in the UI because it is your own content, displayed
  locally. It is never transmitted, and never written outside the cache.
- Nothing from a log is written to stdout; the CLI prints only its own status.
- Test fixtures are entirely synthetic. No real prompt, path, username,
  repository, email or credential is committed to this repository.

## Reporting a vulnerability

Please report suspected vulnerabilities privately via
[GitHub Security Advisories](https://github.com/yuu-biz/agent-session-observer/security/advisories/new)
rather than opening a public issue.

Include what you did, what happened, and what you expected. A proof of concept
helps. You can expect an initial response within about a week.

Things that are especially worth reporting:

- any way for a web page, another origin, or another machine to reach the local
  API or read session content;
- any path traversal, symlink or junction case that reads outside the intended
  directories;
- any outbound network request the tool makes;
- any write to a provider's directory.

## Non-issues

- The dashboard shows your own prompt text. That is the product working.
- The API needs no authentication: it is bound to loopback, guards `Host` and
  `Origin`, and adding a password would not raise the bar against an attacker
  who is already executing code as your user.
