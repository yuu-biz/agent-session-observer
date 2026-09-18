import { promises as fs } from 'node:fs';
import path from 'node:path';

import { asArray, asNumber, asRecord, asString, readJsonl } from '../../core/jsonl.js';
import { parseIsoTs } from '../../core/time.js';
import { categorizeTool, oneLine } from '../../core/tools.js';
import type {
  NormalizedEvent,
  ParseFileInput,
  ParsedSession,
  ProviderAdapter,
  TokenUsage,
} from '../../core/types.js';
import { listFilesBounded } from '../../discovery/fs-scan.js';

/**
 * Codex CLI adapter
 * =================
 *
 * Layout (confirmed against Codex 0.115 .. 0.154 on Windows and Linux):
 *
 *   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO>-<threadId>.jsonl
 *   $CODEX_HOME/archived_sessions/rollout-<ISO>-<threadId>.jsonl
 *   $CODEX_HOME defaults to `~/.codex`.
 *
 * Every line is `{ timestamp, type, payload }`. Codex has shipped three
 * overlapping representations of the same conversation over time:
 *
 *   1. `response_item`  — raw model API items (oldest, still emitted)
 *   2. `event_msg` + `item_completed` — typed UI items (current)
 *   3. `event_msg/user_message` + `agent_message` — TUI-level events
 *
 * A single file often contains more than one of them, so naively reading all
 * three double counts prompts and tool calls. The parser therefore buckets
 * events per channel and, at the end, keeps only the richest channel for each
 * category. New Codex record types land in the bucket for their channel and
 * are ignored rather than crashing the scan.
 */

type Channel = 'item' | 'event' | 'response';

interface Buckets {
  item: NormalizedEvent[];
  event: NormalizedEvent[];
  response: NormalizedEvent[];
  /** Channel-independent: turns, token usage, compaction, session start. */
  common: NormalizedEvent[];
}

function emptyBuckets(): Buckets {
  return { item: [], event: [], response: [], common: [] };
}

function usageFrom(raw: unknown): TokenUsage | undefined {
  const u = asRecord(raw);
  if (!u) return undefined;
  const t: TokenUsage = {};
  const input = asNumber(u.input_tokens);
  const output = asNumber(u.output_tokens);
  const cacheRead = asNumber(u.cached_input_tokens);
  const cacheWrite = asNumber(u.cache_write_input_tokens);
  const reasoning = asNumber(u.reasoning_output_tokens);
  const total = asNumber(u.total_tokens);
  if (input !== undefined) t.input = input;
  if (output !== undefined) t.output = output;
  if (cacheRead !== undefined) t.cacheRead = cacheRead;
  if (cacheWrite !== undefined) t.cacheWrite = cacheWrite;
  if (reasoning !== undefined) t.reasoning = reasoning;
  if (total !== undefined) t.total = total;
  return Object.keys(t).length > 0 ? t : undefined;
}

function textFromContent(content: unknown): string {
  const parts: string[] = [];
  for (const block of asArray(content)) {
    const b = asRecord(block);
    if (!b) {
      if (typeof block === 'string') parts.push(block);
      continue;
    }
    const text = asString(b.text);
    if (text) parts.push(text);
  }
  return parts.join(' ');
}

function commandToString(command: unknown): string {
  if (typeof command === 'string') return command;
  const arr = asArray(command).filter((x): x is string => typeof x === 'string');
  if (arr.length === 0) return '';
  // Drop the shell wrapper so `pwsh -Command <cmd>` reads as `<cmd>`.
  const tail = arr[arr.length - 1];
  return arr.length > 1 && tail ? tail : arr.join(' ');
}

/** Codex writes `Exit code: N` / `Wall time: N seconds` into shell output. */
function parseShellOutput(output: string): { exitCode?: number; durationMs?: number } {
  const out: { exitCode?: number; durationMs?: number } = {};
  const exit = /^Exit code:\s*(-?\d+)/m.exec(output);
  if (exit?.[1]) out.exitCode = Number(exit[1]);
  const wall = /^Wall time:\s*([\d.]+)\s*seconds?/m.exec(output);
  if (wall?.[1]) out.durationMs = Math.round(Number(wall[1]) * 1000);
  return out;
}

/** `apply_patch` returns JSON with `metadata.duration_seconds` / `exit_code`. */
function parseStructuredOutput(output: string): { exitCode?: number; durationMs?: number } {
  const out: { exitCode?: number; durationMs?: number } = {};
  if (!output.startsWith('{')) return parseShellOutput(output);
  try {
    const parsed = asRecord(JSON.parse(output));
    const meta = asRecord(parsed?.metadata);
    const exitCode = asNumber(meta?.exit_code);
    const dur = asNumber(meta?.duration_seconds);
    if (exitCode !== undefined) out.exitCode = exitCode;
    if (dur !== undefined) out.durationMs = Math.round(dur * 1000);
    if (Object.keys(out).length > 0) return out;
    const inner = asString(parsed?.output);
    if (inner) return parseShellOutput(inner);
  } catch {
    return parseShellOutput(output);
  }
  return out;
}

interface CodexState {
  sessionId: string | null;
  parentSessionId?: string;
  isSubagent?: boolean;
  agentLabel?: string;
  sawSessionMeta: boolean;
  title?: string;
  cwd?: string;
  gitBranch?: string;
  cliVersion?: string;
  models: Set<string>;
  tokens: TokenUsage;
  apiMs: number;
  toolMs: number;
  hasApiMs: boolean;
  hasToolMs: boolean;
  buckets: Buckets;
  meta: Record<string, unknown>;
  warnings: string[];
}

function addTokens(target: TokenUsage, src: TokenUsage | undefined): void {
  if (!src) return;
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total'] as const) {
    const v = src[k];
    if (typeof v === 'number') target[k] = (target[k] ?? 0) + v;
  }
}

/**
 * A subagent rollout replays its PARENT's `session_meta` on the following line,
 * so only the first one may define this file's identity. Getting this wrong
 * collapses every subagent thread into its parent and loses the sessions.
 */
function handleSessionMeta(state: CodexState, payload: Record<string, unknown>): void {
  if (state.sawSessionMeta) return;
  state.sawSessionMeta = true;

  // `id` is the per-file thread id; `session_id` may point at a parent thread.
  state.sessionId = asString(payload.id) ?? asString(payload.session_id) ?? state.sessionId;
  state.cwd = asString(payload.cwd) ?? state.cwd;
  state.cliVersion = asString(payload.cli_version) ?? state.cliVersion;

  const git = asRecord(payload.git);
  if (git) state.gitBranch = asString(git.branch) ?? state.gitBranch;

  const source = payload.source;
  const sourceLabel =
    typeof source === 'string' ? source : source ? JSON.stringify(source).slice(0, 120) : undefined;

  state.meta.originator = asString(payload.originator);
  state.meta.source = sourceLabel;
  state.meta.threadSource = asString(payload.thread_source);
  // Codex subagent threads (guardian review, multi-agent runs) get their own
  // rollout file and their own thread id, so they need no synthetic key — but
  // they must still be linked to the thread that spawned them.
  const parentThreadId = asString(payload.parent_thread_id);
  const threadSource = asString(payload.thread_source);
  state.meta.parentThreadId = parentThreadId;
  if (parentThreadId && parentThreadId !== state.sessionId) {
    state.parentSessionId = parentThreadId;
    state.isSubagent = true;
    const subagent = asRecord(asRecord(source)?.subagent);
    state.agentLabel =
      (subagent ? asString(subagent.other) : undefined) ?? threadSource ?? 'subagent';
  }
  state.meta.modelProvider = asString(payload.model_provider);
  if (git) state.meta.repositoryUrl = asString(git.repository_url);
}

function handleItem(state: CodexState, payload: Record<string, unknown>, ts: number): void {
  const item = asRecord(payload.item);
  if (!item) return;
  const type = asString(item.type) ?? 'Unknown';
  const startedAt = asNumber(payload.started_at_ms);
  const completedAt = asNumber(payload.completed_at_ms);
  const durationMs =
    startedAt !== undefined && completedAt !== undefined && completedAt >= startedAt
      ? completedAt - startedAt
      : undefined;
  const id = asString(item.id);

  const push = (e: NormalizedEvent): void => {
    state.buckets.item.push(e);
  };

  switch (type) {
    case 'UserMessage':
      push({ ts, kind: 'user_prompt', subtype: type, summary: oneLine(textFromContent(item.content)) });
      return;
    case 'AgentMessage':
      push({
        ts,
        kind: 'assistant_message',
        subtype: type,
        summary: oneLine(textFromContent(item.content)),
      });
      return;
    case 'Reasoning': {
      const summary = asArray(item.summary_text).filter((x): x is string => typeof x === 'string');
      push({ ts, kind: 'reasoning', subtype: type, summary: oneLine(summary.join(' ')) });
      return;
    }
    case 'CommandExecution': {
      const cmd = commandToString(item.command);
      push({
        ts,
        kind: 'tool_call',
        subtype: type,
        toolName: 'shell',
        toolCategory: 'shell',
        callId: id,
        summary: oneLine(cmd),
        durationMs,
        exitCode: asNumber(item.exit_code),
      });
      if (durationMs !== undefined) {
        state.toolMs += durationMs;
        state.hasToolMs = true;
      }
      return;
    }
    case 'FileChange': {
      const changes = asRecord(item.changes);
      const files = changes ? Object.keys(changes) : [];
      push({
        ts,
        kind: 'tool_call',
        subtype: type,
        toolName: 'apply_patch',
        toolCategory: 'file_edit',
        callId: id,
        summary: oneLine(files.map((f) => path.basename(f)).join(', ')) || 'file change',
        durationMs,
        meta: { fileCount: files.length },
      });
      if (durationMs !== undefined) {
        state.toolMs += durationMs;
        state.hasToolMs = true;
      }
      return;
    }
    case 'McpToolCall': {
      const server = asString(item.server) ?? 'mcp';
      const tool = asString(item.tool) ?? 'call';
      push({
        ts,
        kind: 'tool_call',
        subtype: type,
        toolName: `mcp__${server}__${tool}`,
        toolCategory: 'mcp',
        callId: id,
        summary: oneLine(`${server}.${tool}`),
        durationMs,
      });
      if (durationMs !== undefined) {
        state.toolMs += durationMs;
        state.hasToolMs = true;
      }
      return;
    }
    case 'WebSearch':
    case 'Extension': {
      push({
        ts,
        kind: 'tool_call',
        subtype: type,
        toolName: asString(item.kind) ?? 'web_search',
        toolCategory: 'web',
        callId: id,
        summary: oneLine(asString(item.query) ?? type),
        durationMs,
      });
      return;
    }
    case 'ImageView': {
      push({
        ts,
        kind: 'tool_call',
        subtype: type,
        toolName: 'view_image',
        toolCategory: 'file_read',
        callId: id,
        summary: oneLine(asString(item.path) ?? ''),
      });
      return;
    }
    case 'ContextCompaction':
      push({ ts, kind: 'compaction', subtype: type, summary: 'context compacted' });
      return;
    case 'Error':
      push({ ts, kind: 'error', subtype: type, summary: oneLine(asString(item.message) ?? 'error') });
      return;
    default:
      push({ ts, kind: 'system', subtype: type, summary: type });
  }
}

function handleEventMsg(state: CodexState, payload: Record<string, unknown>, ts: number): void {
  const type = asString(payload.type) ?? '';

  switch (type) {
    case 'item_completed':
      handleItem(state, payload, ts);
      return;
    case 'user_message':
      state.buckets.event.push({
        ts,
        kind: 'user_prompt',
        subtype: type,
        summary: oneLine(asString(payload.message)),
      });
      return;
    case 'agent_message':
      state.buckets.event.push({
        ts,
        kind: 'assistant_message',
        subtype: type,
        summary: oneLine(asString(payload.message)),
      });
      return;
    case 'task_started':
      state.buckets.common.push({ ts, kind: 'turn_start', subtype: type });
      return;
    case 'task_complete': {
      const durationMs = asNumber(payload.duration_ms);
      if (durationMs !== undefined) {
        state.apiMs += durationMs;
        state.hasApiMs = true;
      }
      state.buckets.common.push({
        ts,
        kind: 'turn_end',
        subtype: type,
        durationMs,
        meta: { timeToFirstTokenMs: asNumber(payload.time_to_first_token_ms) },
      });
      return;
    }
    case 'turn_aborted':
      state.buckets.common.push({ ts, kind: 'turn_end', subtype: type, summary: 'turn aborted' });
      return;
    case 'context_compacted':
      state.buckets.common.push({ ts, kind: 'compaction', subtype: type, summary: 'context compacted' });
      return;
    case 'thread_settings_applied': {
      const settings = asRecord(payload.thread_settings);
      const model = asString(settings?.model);
      if (model) state.models.add(model);
      return;
    }
    case 'error':
    case 'stream_error':
      state.buckets.common.push({
        ts,
        kind: 'error',
        subtype: type,
        summary: oneLine(asString(payload.message) ?? type),
      });
      return;
    case 'token_count':
      // Cumulative snapshot; `token_usage_record` carries the per-response
      // delta and is what we sum, so this record is intentionally dropped.
      return;
    default:
      return;
  }
}

function handleResponseItem(state: CodexState, payload: Record<string, unknown>, ts: number): void {
  const type = asString(payload.type) ?? '';

  switch (type) {
    case 'message': {
      const role = asString(payload.role);
      const text = oneLine(textFromContent(payload.content));
      if (role === 'user') {
        state.buckets.response.push({ ts, kind: 'user_prompt', subtype: type, summary: text });
      } else if (role === 'assistant') {
        state.buckets.response.push({ ts, kind: 'assistant_message', subtype: type, summary: text });
      } else {
        // `developer` / `system` messages are instructions, not user activity.
        state.buckets.response.push({ ts, kind: 'system', subtype: `${type}:${role ?? '?'}` });
      }
      return;
    }
    case 'reasoning':
      state.buckets.response.push({ ts, kind: 'reasoning', subtype: type });
      return;
    case 'function_call':
    case 'custom_tool_call': {
      const name = asString(payload.name) ?? 'tool';
      const args = asString(payload.arguments) ?? asString(payload.input) ?? '';
      state.buckets.response.push({
        ts,
        kind: 'tool_call',
        subtype: type,
        toolName: name,
        toolCategory: categorizeTool(name),
        callId: asString(payload.call_id),
        summary: oneLine(args),
      });
      return;
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const output = asString(payload.output) ?? '';
      const parsed = parseStructuredOutput(output);
      if (parsed.durationMs !== undefined) {
        state.toolMs += parsed.durationMs;
        state.hasToolMs = true;
      }
      state.buckets.response.push({
        ts,
        kind: 'tool_result',
        subtype: type,
        callId: asString(payload.call_id),
        durationMs: parsed.durationMs,
        exitCode: parsed.exitCode,
      });
      return;
    }
    default:
      return;
  }
}

function pickChannel(buckets: Buckets): Channel {
  const score = (list: NormalizedEvent[]): number =>
    list.filter((e) => e.kind === 'user_prompt' || e.kind === 'tool_call').length;
  const item = score(buckets.item);
  const event = score(buckets.event);
  const response = score(buckets.response);
  if (item >= event && item >= response && item > 0) return 'item';
  if (event >= response && event > 0) return 'event';
  if (response > 0) return 'response';
  // Nothing conclusive: prefer whichever bucket has any content at all.
  if (buckets.item.length > 0) return 'item';
  if (buckets.event.length > 0) return 'event';
  return 'response';
}

export const codexAdapter: ProviderAdapter = {
  id: 'codex',
  displayName: 'Codex CLI',
  homeDirNames: ['.codex'],
  homeEnvVar: 'CODEX_HOME',

  async listLogFiles(rootPath: string): Promise<string[]> {
    const out: string[] = [];
    // sessions/YYYY/MM/DD/*.jsonl — depth 4, no deeper, no symlink following.
    out.push(
      ...(await listFilesBounded(path.join(rootPath, 'sessions'), {
        maxDepth: 4,
        match: (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'),
      })),
    );
    out.push(
      ...(await listFilesBounded(path.join(rootPath, 'archived_sessions'), {
        maxDepth: 4,
        match: (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'),
      })),
    );
    return out;
  },

  async parseFile(input: ParseFileInput): Promise<ParsedSession | null> {
    const { filePath, fromOffset, previous } = input;

    const state: CodexState = {
      sessionId: previous?.sessionId ?? null,
      parentSessionId: previous?.parentSessionId,
      isSubagent: previous?.isSubagent,
      agentLabel: previous?.agentLabel,
      sawSessionMeta: previous?.sessionId != null,
      title: previous?.title,
      cwd: previous?.cwd,
      gitBranch: previous?.gitBranch,
      cliVersion: previous?.cliVersion,
      models: new Set(previous?.models ?? []),
      tokens: { ...(previous?.tokens ?? {}) },
      apiMs: previous?.measured.apiMs ?? 0,
      toolMs: previous?.measured.toolMs ?? 0,
      hasApiMs: previous?.measured.apiMs !== undefined,
      hasToolMs: previous?.measured.toolMs !== undefined,
      buckets: emptyBuckets(),
      meta: { ...(previous?.providerMeta ?? {}) },
      warnings: [],
    };

    const read = await readJsonl(
      filePath,
      (line) => {
        if (line.value === null) return;
        const rec = asRecord(line.value);
        if (!rec) return;

        const ts = parseIsoTs(rec.timestamp);
        if (ts === null) return;
        const type = asString(rec.type) ?? '';
        const payload = asRecord(rec.payload);

        switch (type) {
          case 'session_meta':
            if (payload) handleSessionMeta(state, payload);
            state.buckets.common.push({ ts, kind: 'session_start', subtype: type });
            return;
          case 'turn_context': {
            const model = asString(payload?.model);
            if (model) state.models.add(model);
            const cwd = asString(payload?.cwd);
            if (cwd && !state.cwd) state.cwd = cwd;
            return;
          }
          case 'event_msg':
            if (payload) handleEventMsg(state, payload, ts);
            return;
          case 'response_item':
            if (payload) handleResponseItem(state, payload, ts);
            return;
          case 'token_usage_record': {
            addTokens(state.tokens, usageFrom(payload?.usage));
            state.buckets.common.push({
              ts,
              kind: 'model_usage',
              subtype: type,
              tokens: usageFrom(payload?.usage),
            });
            return;
          }
          case 'compacted':
            state.buckets.common.push({ ts, kind: 'compaction', subtype: type });
            return;
          case 'world_state':
          default:
            return;
        }
      },
      { fromOffset: fromOffset ?? 0 },
    );

    if (read.malformedLines > 0) {
      state.warnings.push(
        `${path.basename(filePath)}: ${read.malformedLines} malformed line(s) skipped`,
      );
    }
    if (read.trailingPartial) {
      state.warnings.push(`${path.basename(filePath)}: file ends with a partial line (being written?)`);
    }

    // The filename carries the thread id in every Codex version observed, and
    // unlike `session_meta` it cannot be overwritten by replayed parent
    // records, so it is preferred whenever it is well formed.
    const fromName = /rollout-.*?-([0-9a-fA-F]{8}-[0-9a-fA-F-]{27})\.jsonl$/.exec(
      path.basename(filePath),
    )?.[1];
    if (fromName) state.sessionId = fromName;
    if (!state.sessionId) state.sessionId = path.basename(filePath, '.jsonl');

    const channel: Channel = (state.meta.channel as Channel | undefined) ?? pickChannel(state.buckets);
    state.meta.channel = channel;

    const fresh = [...state.buckets.common, ...state.buckets[channel]];
    const events = previous ? [...previous.events, ...fresh] : fresh;
    events.sort((a, b) => a.ts - b.ts);

    if (!state.title) {
      const firstPrompt = events.find((e) => e.kind === 'user_prompt' && e.summary);
      state.title = firstPrompt?.summary ? oneLine(firstPrompt.summary, 80) : undefined;
    }

    return {
      sessionId: state.sessionId,
      title: state.title,
      cwd: state.cwd,
      gitBranch: state.gitBranch,
      models: [...state.models],
      cliVersion: state.cliVersion,
      parentSessionId: state.parentSessionId,
      isSubagent: state.isSubagent,
      agentLabel: state.agentLabel,
      events,
      measured: {
        apiMs: state.hasApiMs ? state.apiMs : undefined,
        toolMs: state.hasToolMs ? state.toolMs : undefined,
        source: 'codex task_complete.duration_ms / tool output metadata',
      },
      tokens: state.tokens,
      providerMeta: state.meta,
      warnings: [...(previous?.warnings ?? []), ...state.warnings],
      bytesConsumed: read.bytesConsumed,
    };
  },
};

/**
 * Codex publishes no per-session runtime marker, so liveness for Codex is
 * inferred from log recency alone. This hook exists so that a future Codex
 * release adding one can be supported without touching `core/`.
 */
export async function codexRootExists(rootPath: string): Promise<boolean> {
  try {
    const st = await fs.stat(path.join(rootPath, 'sessions'));
    return st.isDirectory();
  } catch {
    return false;
  }
}
