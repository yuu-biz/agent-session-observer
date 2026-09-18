# Test fixtures

Everything in this directory is **synthetic**. No real session log, prompt,
username, repository, absolute path, token or credential from any machine is
committed here.

The files mimic the *record shapes* of Codex CLI and Claude Code closely enough
to exercise the parsers, and nothing else:

| File | Purpose |
| --- | --- |
| `codex/sessions/2024/03/04/rollout-2024-03-04T09-00-00-11111111-1111-4111-8111-111111111111.jsonl` | Modern Codex layout: `session_meta`, `turn_context`, `item_completed` items, `token_usage_record`, `task_complete` durations |
| `codex/sessions/2024/03/04/rollout-2024-03-04T10-00-00-22222222-2222-4222-8222-222222222222.jsonl` | Legacy Codex layout: `response_item` only (`function_call` / `custom_tool_call`), plus a malformed line and a truncated final line |
| `codex/sessions/2024/03/04/rollout-2024-03-04T11-00-00-33333333-3333-4333-8333-333333333333.jsonl` | Subagent rollout that replays its parent's `session_meta` on line 2 |
| `claude-code/projects/-tmp-demo/aaaaaaaa-.../...jsonl` | Claude Code session: user/assistant/tool_use/tool_result/system/cost-state |
| `claude-code/projects/-tmp-demo/aaaaaaaa-.../subagents/agent-demo.jsonl` | Subagent transcript carrying the parent's `sessionId` |

If a provider changes its format, add a *new* fixture rather than editing an
existing one — the old shape still needs to keep parsing.
