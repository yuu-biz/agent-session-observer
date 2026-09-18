# CLAUDE.md

See **[AGENTS.md](AGENTS.md)** — it is the single source of guidance for this
repository and applies to Claude Code exactly as written: commands, architecture
boundaries, the rules for adding a provider adapter, the activity/concurrency
semantics that must not be broken, the privacy invariants, and testing
expectations.

Two notes specific to working here with Claude Code:

- This repository parses Claude Code's own session logs. Your current session is
  being written to `~/.claude/projects/<project>/<session>.jsonl` while you work,
  so `npm run dev` will show it — useful for verifying changes against real data.
  Never commit any of that content; fixtures are synthetic only.
- `src/adapters/claude-code/` encodes observed log structure. If you change it,
  re-read the actual records first rather than relying on recall; the format
  moves between releases.
