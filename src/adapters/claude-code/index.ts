import { promises as fs } from 'node:fs';
import path from 'node:path';

import { asArray, asNumber, asRecord, asString, readJsonl } from '../../core/jsonl.js';
import { parseIsoTs } from '../../core/time.js';
import { categorizeTool, oneLine } from '../../core/tools.js';
import type {
  LiveMarker,
  NormalizedEvent,
  ParseFileInput,
  ParsedSession,
  ProviderAdapter,
  TokenUsage,
} from '../../core/types.js';
import { listFilesBounded } from '../../discovery/fs-scan.js';
import { isPidAlive } from '../../discovery/process.js';

/**
 * Claude Code adapter
 * ===================
 *
 * Layout (confirmed against Claude Code 2.1.x and the official `.claude`
 * directory reference):
 *
 *   $CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<sessionId>.jsonl
 *   $CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<sessionId>/subagents/*.jsonl
 *   $CLAUDE_CONFIG_DIR/sessions/<pid>.json        <- live session markers
 *   $CLAUDE_CONFIG_DIR defaults to `~/.claude`.
 *
 * Records are flat objects discriminated by `type`. The two that matter most:
 *
 *   `assistant` — carries `message.usage` (the only token source) and
 *                 `message.model`.
 *   `cost-state` — Claude Code's own rollup, and the same numbers `/cost`
 *                 prints: `totalCostUSD`, `totalAPIDuration`, `totalToolDuration`,
 *                 `totalDuration`, `modelUsage`. These are MEASURED values and
 *                 are surfaced separately from our own estimates.
 *
 * `.orphaned-*.jsonl` files are previous transcripts Claude Code set aside; they
 * duplicate a live session and are skipped.
 */

/**
 * Recognises `.../projects/<project>/<parentSessionId>/subagents/<agent>.jsonl`.
 * Returns `null` for ordinary session transcripts.
 */
export function detectSubagent(
  filePath: string,
): { parentSessionId: string | null; agentLabel: string } | null {
  const parts = filePath.split(/[\\/]/);
  const idx = parts.lastIndexOf('subagents');
  if (idx <= 0 || idx >= parts.length - 1) return null;
  const parent = parts[idx - 1] ?? null;
  const file = parts[parts.length - 1] ?? '';
  return { parentSessionId: parent, agentLabel: file.replace(/\.jsonl$/, '') };
}

interface ClaudeState {
  sessionId: string | null;
  parentSessionId?: string;
  isSubagent?: boolean;
  agentLabel?: string;
  title?: string;
  cwd?: string;
  gitBranch?: string;
  cliVersion?: string;
  models: Set<string>;
  tokens: TokenUsage;
  events: NormalizedEvent[];
  costUsd?: number;
  apiMs?: number;
  toolMs?: number;
  totalMs?: number;
  meta: Record<string, unknown>;
  warnings: string[];
  /** tool_use id -> tool name, so results can be labelled. */
  toolNames: Map<string, string>;
}

function usageFrom(raw: unknown): TokenUsage | undefined {
  const u = asRecord(raw);
  if (!u) return undefined;
  const t: TokenUsage = {};
  const input = asNumber(u.input_tokens);
  const output = asNumber(u.output_tokens);
  const cacheRead = asNumber(u.cache_read_input_tokens);
  const cacheWrite = asNumber(u.cache_creation_input_tokens);
  if (input !== undefined) t.input = input;
  if (output !== undefined) t.output = output;
  if (cacheRead !== undefined) t.cacheRead = cacheRead;
  if (cacheWrite !== undefined) t.cacheWrite = cacheWrite;
  const details = asRecord(u.output_tokens_details);
  const thinking = asNumber(details?.thinking_tokens);
  if (thinking !== undefined) t.reasoning = thinking;
  if (Object.keys(t).length === 0) return undefined;
  t.total = (t.input ?? 0) + (t.output ?? 0);
  return t;
}

function addTokens(target: TokenUsage, src: TokenUsage | undefined): void {
  if (!src) return;
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total'] as const) {
    const v = src[k];
    if (typeof v === 'number') target[k] = (target[k] ?? 0) + v;
  }
}

/** Extracts plain text from a Claude message `content`, which may be a string. */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const block of asArray(content)) {
    const b = asRecord(block);
    if (!b) continue;
    if (b.type === 'text') {
      const t = asString(b.text);
      if (t) parts.push(t);
    }
  }
  return parts.join(' ');
}

/** A one-line label for a tool call, derived from its most identifying input. */
function toolSummary(name: string, rawInput: unknown): string {
  const input = asRecord(rawInput);
  if (!input) return name;
  for (const key of ['command', 'file_path', 'pattern', 'path', 'query', 'url', 'prompt', 'skill']) {
    const v = asString(input[key]);
    if (v) return oneLine(v);
  }
  return name;
}

function handleUser(state: ClaudeState, rec: Record<string, unknown>, ts: number): void {
  const message = asRecord(rec.message);
  const content = message?.content;

  // Tool results arrive as `user` records whose content is a tool_result block.
  let sawToolResult = false;
  for (const block of asArray(content)) {
    const b = asRecord(block);
    if (b?.type !== 'tool_result') continue;
    sawToolResult = true;
    const id = asString(b.tool_use_id);
    const isError = b.is_error === true;
    state.events.push({
      ts,
      kind: isError ? 'error' : 'tool_result',
      subtype: 'tool_result',
      callId: id,
      toolName: id ? state.toolNames.get(id) : undefined,
      summary: isError ? 'tool error' : undefined,
    });
  }
  if (sawToolResult) return;

  // `isMeta` records are injected context, not something the human typed.
  if (rec.isMeta === true) {
    state.events.push({ ts, kind: 'system', subtype: 'meta' });
    return;
  }

  const text = messageText(content);
  state.events.push({
    ts,
    kind: 'user_prompt',
    subtype: 'user',
    summary: oneLine(text),
    meta: rec.isSidechain === true ? { sidechain: true } : undefined,
  });
}

function handleAssistant(state: ClaudeState, rec: Record<string, unknown>, ts: number): void {
  const message = asRecord(rec.message);
  const model = asString(message?.model);
  if (model) state.models.add(model);

  const usage = usageFrom(message?.usage);
  if (usage) addTokens(state.tokens, usage);

  if (rec.isApiErrorMessage === true) {
    state.events.push({
      ts,
      kind: 'error',
      subtype: 'api_error',
      summary: oneLine(asString(rec.apiErrorStatus) ?? 'API error'),
      model,
    });
    return;
  }

  let emitted = false;
  for (const block of asArray(message?.content)) {
    const b = asRecord(block);
    if (!b) continue;
    if (b.type === 'tool_use') {
      const name = asString(b.name) ?? 'tool';
      const id = asString(b.id);
      if (id) state.toolNames.set(id, name);
      state.events.push({
        ts,
        kind: 'tool_call',
        subtype: 'tool_use',
        toolName: name,
        toolCategory: categorizeTool(name),
        callId: id,
        summary: toolSummary(name, b.input),
        model,
      });
      emitted = true;
    } else if (b.type === 'thinking') {
      state.events.push({ ts, kind: 'reasoning', subtype: 'thinking', model });
      emitted = true;
    }
  }

  const text = messageText(message?.content);
  if (text.trim().length > 0) {
    state.events.push({
      ts,
      kind: 'assistant_message',
      subtype: 'assistant',
      summary: oneLine(text),
      model,
      tokens: usage,
    });
    emitted = true;
  }

  if (!emitted) {
    state.events.push({ ts, kind: 'model_usage', subtype: 'assistant', model, tokens: usage });
  }
}

function handleSystem(state: ClaudeState, rec: Record<string, unknown>, ts: number): void {
  const subtype = asString(rec.subtype) ?? 'system';
  if (subtype === 'turn_duration') {
    // Wall time of one assistant turn as Claude Code measured it.
    const durationMs = asNumber(rec.durationMs);
    state.events.push({ ts, kind: 'turn_end', subtype, durationMs });
    return;
  }
  if (rec.level === 'error') {
    state.events.push({ ts, kind: 'error', subtype, summary: oneLine(asString(rec.content)) });
    return;
  }
  state.events.push({ ts, kind: 'system', subtype, summary: oneLine(asString(rec.content), 100) });
}

function handleCostState(state: ClaudeState, rec: Record<string, unknown>): void {
  // Last writer wins: `cost-state` is a cumulative snapshot, not a delta.
  const cost = asNumber(rec.totalCostUSD);
  if (cost !== undefined) state.costUsd = cost;
  const api = asNumber(rec.totalAPIDuration);
  if (api !== undefined) state.apiMs = api;
  const tool = asNumber(rec.totalToolDuration);
  if (tool !== undefined) state.toolMs = tool;
  const total = asNumber(rec.totalDuration);
  if (total !== undefined) state.totalMs = total;

  const modelUsage = asRecord(rec.modelUsage);
  if (modelUsage) {
    for (const model of Object.keys(modelUsage)) state.models.add(model);
    state.meta.modelUsage = modelUsage;
  }
  const added = asNumber(rec.totalLinesAdded);
  const removed = asNumber(rec.totalLinesRemoved);
  if (added !== undefined) state.meta.linesAdded = added;
  if (removed !== undefined) state.meta.linesRemoved = removed;
  if (rec.hasUnknownModelCost === true) state.meta.hasUnknownModelCost = true;
}

export const claudeCodeAdapter: ProviderAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
  homeDirNames: ['.claude'],
  homeEnvVar: 'CLAUDE_CONFIG_DIR',

  async listLogFiles(rootPath: string): Promise<string[]> {
    // projects/<encoded-cwd>/<session>.jsonl plus one nested level for
    // subagent transcripts. Depth 4 is enough and keeps the scan bounded.
    return listFilesBounded(path.join(rootPath, 'projects'), {
      maxDepth: 4,
      match: (name) => name.endsWith('.jsonl') && !name.includes('.orphaned-'),
    });
  },

  async parseFile(input: ParseFileInput): Promise<ParsedSession | null> {
    const { filePath, fromOffset, previous } = input;

    const state: ClaudeState = {
      sessionId: previous?.sessionId ?? null,
      parentSessionId: previous?.parentSessionId,
      isSubagent: previous?.isSubagent,
      agentLabel: previous?.agentLabel,
      title: previous?.title,
      cwd: previous?.cwd,
      gitBranch: previous?.gitBranch,
      cliVersion: previous?.cliVersion,
      models: new Set(previous?.models ?? []),
      tokens: { ...(previous?.tokens ?? {}) },
      events: [],
      costUsd: previous?.costUsd,
      apiMs: previous?.measured.apiMs,
      toolMs: previous?.measured.toolMs,
      totalMs: previous?.measured.totalMs,
      meta: { ...(previous?.providerMeta ?? {}) },
      warnings: [],
      toolNames: new Map(),
    };

    const read = await readJsonl(
      filePath,
      (line) => {
        if (line.value === null) return;
        const rec = asRecord(line.value);
        if (!rec) return;

        const type = asString(rec.type) ?? '';
        const sid = asString(rec.sessionId) ?? asString(rec.session_id);
        if (sid && !state.sessionId) state.sessionId = sid;
        const cwd = asString(rec.cwd);
        if (cwd && !state.cwd) state.cwd = cwd;
        const branch = asString(rec.gitBranch);
        if (branch) state.gitBranch = branch;
        const version = asString(rec.version);
        if (version) state.cliVersion = version;

        const ts = parseIsoTs(rec.timestamp);

        switch (type) {
          case 'user':
            if (ts !== null) handleUser(state, rec, ts);
            return;
          case 'assistant':
            if (ts !== null) handleAssistant(state, rec, ts);
            return;
          case 'system':
            if (ts !== null) handleSystem(state, rec, ts);
            return;
          case 'cost-state':
            handleCostState(state, rec);
            return;
          case 'ai-title':
            state.title = asString(rec.aiTitle) ?? state.title;
            return;
          case 'custom-title':
            state.title = asString(rec.customTitle) ?? state.title;
            return;
          case 'summary':
            state.title = state.title ?? asString(rec.summary);
            return;
          case 'pr-link': {
            const url = asString(rec.prUrl);
            if (ts !== null && url) {
              state.events.push({ ts, kind: 'system', subtype: 'pr-link', summary: url });
            }
            return;
          }
          case 'permission-mode':
            state.meta.permissionMode = asString(rec.permissionMode) ?? state.meta.permissionMode;
            return;
          case 'mode':
            state.meta.mode = asString(rec.mode) ?? state.meta.mode;
            return;
          case 'attachment':
          case 'file-history-snapshot':
          case 'file-history-delta':
          case 'last-prompt':
          case 'bridge-session':
          case 'atis-latch':
          case 'queue-operation':
          case 'fork-context-ref':
          default:
            // Bookkeeping records carry no activity signal. Unknown future
            // types land here too, which is why the scan survives upgrades.
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

    if (!state.sessionId) state.sessionId = path.basename(filePath, '.jsonl');

    // Subagent transcripts live at `<parent-session-id>/subagents/<agent>.jsonl`
    // and record the PARENT's `sessionId` on every line. Treating them as the
    // parent would silently discard them as duplicates, so they become distinct
    // child sessions instead — which is also the truthful model for
    // concurrency, since subagents really do run alongside their parent.
    const sub = detectSubagent(filePath);
    if (sub) {
      state.parentSessionId = sub.parentSessionId ?? state.sessionId;
      state.sessionId = `${state.parentSessionId}#${sub.agentLabel}`;
      state.agentLabel = sub.agentLabel;
      state.isSubagent = true;
      if (!state.title) state.title = `subagent: ${sub.agentLabel}`;
    }

    const events = previous ? [...previous.events, ...state.events] : state.events;
    events.sort((a, b) => a.ts - b.ts);

    if (events.length === 0) return null;

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
        apiMs: state.apiMs,
        toolMs: state.toolMs,
        totalMs: state.totalMs,
        source: 'claude-code cost-state (same values as /cost)',
      },
      tokens: state.tokens,
      costUsd: state.costUsd,
      providerMeta: state.meta,
      warnings: [...(previous?.warnings ?? []), ...state.warnings],
      bytesConsumed: read.bytesConsumed,
    };
  },

  /**
   * Claude Code keeps one small JSON file per running session under
   * `sessions/<pid>.json`, with a `status` (`busy` / `idle`) and an `updatedAt`
   * heartbeat. That is the strongest liveness evidence available to us, so it
   * is read on every refresh.
   *
   * Markers are only trusted for the local host: a pid from inside a WSL distro
   * means nothing to the Windows process table, so `pidAlive` is left undefined
   * there rather than being wrongly reported as dead.
   */
  async collectLiveMarkers(rootPath: string): Promise<LiveMarker[]> {
    const dir = path.join(rootPath, 'sessions');
    const out: LiveMarker[] = [];
    // A pid recorded inside a WSL distro is meaningless to the Windows process
    // table, so we must not test it and must not claim the session is dead.
    const isForeignHost = /^\\\\wsl(\.localhost|\$)\\/i.test(rootPath);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return out;
    }

    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(dir, name), 'utf8');
        const rec = asRecord(JSON.parse(raw));
        const sessionId = asString(rec?.sessionId);
        if (!sessionId) continue;
        const pid = asNumber(rec?.pid);
        out.push({
          sessionId,
          state: asString(rec?.status),
          updatedAtMs: asNumber(rec?.updatedAt) ?? asNumber(rec?.statusUpdatedAt),
          pid,
          pidAlive: pid !== undefined && !isForeignHost ? isPidAlive(pid) : undefined,
          cwd: asString(rec?.cwd),
          source: 'claude-code sessions/<pid>.json',
        });
      } catch {
        // A marker being rewritten while we read it is expected.
      }
    }
    return out;
  },
};
