/**
 * Normalized domain model shared by every provider adapter.
 *
 * Adapters MUST map their native log records onto these types, and MAY keep
 * anything that does not fit inside `providerMeta`. The UI and the analysis
 * layer only ever read the normalized fields, so adding a provider never
 * requires touching `core/` or `web/`.
 */

import type { ModelCost } from './pricing.js';

export type { ModelCost };

export type ProviderId = 'codex' | 'claude-code';

/** Where a log tree physically lives. */
export type HostKind = 'local' | 'wsl';

export interface HostRef {
  kind: HostKind;
  /** WSL distribution name; undefined for `local`. */
  distro?: string;
  /** Stable, human readable label, e.g. `local` or `wsl:Ubuntu`. */
  label: string;
}

/** How a discovery root was found. Used for diagnostics in the UI. */
export type RootOrigin = 'default' | 'env' | 'config' | 'manual';

export interface DiscoveryRoot {
  /** Stable id: `${provider}:${host.label}:${path}`. */
  id: string;
  provider: ProviderId;
  host: HostRef;
  /** Provider home directory (e.g. `.../.codex`), OS-native form. */
  path: string;
  origin: RootOrigin;
  /** Populated when the root was found but cannot be read. */
  error?: string;
}

/**
 * Normalized event kinds. Deliberately small: anything provider specific goes
 * into `subtype` / `meta` rather than growing this union.
 */
export type EventKind =
  | 'session_start'
  | 'user_prompt'
  | 'assistant_message'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'model_usage'
  | 'turn_start'
  | 'turn_end'
  | 'compaction'
  | 'error'
  | 'system';

/**
 * Token counts, normalized so the same field means the same thing whichever
 * provider produced it.
 *
 * The buckets are disjoint: `input` is prompt tokens that were NOT served from
 * cache. OpenAI reports cached tokens *inside* its input count and Anthropic
 * reports them beside it, so the Codex adapter subtracts. Without that, the
 * same conversation looks more expensive under one CLI than the other purely
 * because of how each one counts — and every ratio built on top inherits that
 * skew.
 */
export interface TokenUsage {
  /** Prompt tokens billed at the full input rate (cache misses only). */
  input?: number;
  output?: number;
  /** Prompt tokens served from the provider's cache, billed at a discount. */
  cacheRead?: number;
  /** Prompt tokens written into the cache, where the provider charges for it. */
  cacheWrite?: number;
  /** Thinking tokens. A SUBSET of `output`, never added to it. */
  reasoning?: number;
  /** The provider's own total, when it reports one. Not a sum of the above. */
  total?: number;
}

/** Coarse classification of a tool call, used for "notable events". */
export type ToolCategory =
  | 'shell'
  | 'file_read'
  | 'file_edit'
  | 'search'
  | 'web'
  | 'mcp'
  | 'agent'
  | 'other';

export interface NormalizedEvent {
  /** Unix epoch milliseconds, UTC. */
  ts: number;
  kind: EventKind;
  /** Provider-native record discriminator, kept verbatim for inspection. */
  subtype?: string;
  /** One-line summary safe to render in a list. */
  summary?: string;
  /** Tool name for `tool_call` / `tool_result`. */
  toolName?: string;
  toolCategory?: ToolCategory;
  /** Correlation id linking `tool_call` to `tool_result`. */
  callId?: string;
  /** Measured duration reported by the provider, if any. Never estimated. */
  durationMs?: number;
  /** Process exit code when the provider reports one. */
  exitCode?: number;
  tokens?: TokenUsage;
  model?: string;
  /** Provider specific leftovers. */
  meta?: Record<string, unknown>;
}

/** A half-open interval `[start, end)` in epoch milliseconds. */
export interface Interval {
  start: number;
  end: number;
}

export interface IdleGap extends Interval {
  durationMs: number;
}

/**
 * Durations that the provider *measured* and wrote to the log. These are facts,
 * not estimates, and the UI labels them differently from `ActivityEstimate`.
 */
export interface MeasuredDurations {
  /** Sum of model/API round-trip time reported by the provider. */
  apiMs?: number;
  /** Sum of tool execution time reported by the provider. */
  toolMs?: number;
  /** Provider's own notion of total session duration, when it records one. */
  totalMs?: number;
  /** Where the numbers came from, shown as a tooltip in the UI. */
  source?: string;
}

/**
 * Derived, threshold-dependent activity figures. Everything here is an
 * ESTIMATE and must be presented as such.
 */
export interface ActivityEstimate {
  /** Idle threshold (ms) the segments were computed with. */
  idleThresholdMs: number;
  /** Maximal runs of events with no gap longer than the idle threshold. */
  segments: Interval[];
  /** Sum of segment durations. Lower bound on real working time. */
  activeMs: number;
  /** `wallSpanMs - activeMs`. */
  idleMs: number;
  idleGaps: IdleGap[];
}

export interface SessionCounters {
  events: number;
  userPrompts: number;
  assistantMessages: number;
  toolCalls: number;
  errors: number;
  compactions: number;
}

/** Evidence-graded liveness. Never present an estimate as a fact. */
export type LiveStatus = 'active' | 'recently_active' | 'likely_idle' | 'ended';

export interface LiveState {
  status: LiveStatus;
  /** How much to trust `status`. `low` when only file mtime is available. */
  confidence: 'high' | 'medium' | 'low';
  /** Human readable reasons, rendered verbatim in the UI. */
  evidence: string[];
}

/** A user prompt and the work that followed it, up to the next prompt. */
export interface SessionPhase {
  index: number;
  startTs: number;
  endTs: number;
  /** First line of the user prompt. Local-only, never transmitted. */
  title: string;
  toolCalls: number;
  tokens?: TokenUsage;
}

/** Everything the dashboard needs about a session without re-reading the log. */
export interface SessionSummary {
  /** `${provider}:${sessionId}` — unique across providers. */
  key: string;
  provider: ProviderId;
  /** Provider-native session/thread id. */
  sessionId: string;
  host: HostRef;
  rootId: string;
  /** Absolute path of the backing log file (local-only, never transmitted). */
  filePath: string;
  fileSize: number;
  fileMtimeMs: number;

  title?: string;
  cwd?: string;
  gitBranch?: string;
  models: string[];
  cliVersion?: string;
  /** Parent session when this log is a subagent transcript. */
  parentSessionId?: string;
  /** `${provider}:${parentSessionId}`, for grouping in the UI. */
  parentSessionKey?: string;
  isSubagent?: boolean;
  /** Human label for a subagent, e.g. the agent name. */
  agentLabel?: string;

  startedAt: number;
  endedAt: number;
  wallSpanMs: number;

  activity: ActivityEstimate;
  measured: MeasuredDurations;
  counters: SessionCounters;
  tokens: TokenUsage;
  /** Token usage split by model. Empty when the provider labels no usage. */
  tokensByModel: Record<string, TokenUsage>;
  /** Only when the provider reports real money, e.g. Claude Code `cost-state`. */
  costUsd?: number;
  /**
   * Tokens x a price list, for the models the provider did not price itself.
   * An ESTIMATE, kept in its own field so it can never be read as `costUsd`.
   */
  estimatedCostUsd?: number;
  /** Per-model split, each row carrying whether it was measured or estimated. */
  modelCosts: ModelCost[];
  /** Models with real token usage that no rate covers. Never counted as zero. */
  unpricedModels: string[];

  live: LiveState;
  /** Set when another file describes the same session and was preferred. */
  duplicateOf?: string;
  /** Provider-specific extras the UI may show in a "raw" panel. */
  providerMeta?: Record<string, unknown>;
}

/** Full detail, loaded on demand for one session. */
export interface SessionDetail extends SessionSummary {
  phases: SessionPhase[];
  events: NormalizedEvent[];
  /** True when the event list was capped; the UI says so explicitly. */
  eventsTruncated: boolean;
}

/**
 * The contract every provider adapter implements.
 *
 * `parseFile` is called once per log file. It must be tolerant: a truncated or
 * half-written last line is normal (the agent may be writing right now) and
 * must never throw.
 */
export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  /** Candidate provider home directory names relative to a user home. */
  readonly homeDirNames: readonly string[];
  /** Environment variable that overrides the provider home, if any. */
  readonly homeEnvVar?: string;
  /** Returns log files under a root: bounded depth, no symlink following. */
  listLogFiles(rootPath: string): Promise<string[]>;
  /** Parses one log file into at most one session (providers may return none). */
  parseFile(input: ParseFileInput): Promise<ParsedSession | null>;
  /** Extra liveness evidence from provider runtime markers. */
  collectLiveMarkers?(rootPath: string): Promise<LiveMarker[]>;
}

export interface ParseFileInput {
  filePath: string;
  root: DiscoveryRoot;
  /** Byte offset already consumed by a previous parse (incremental mode). */
  fromOffset?: number;
  /** Carried-over state from the previous incremental parse. */
  previous?: ParsedSession | null;
  /** When set, keep at most this many events in memory. */
  maxEvents?: number;
}

/** Adapter output before core analysis (segments, liveness) is applied. */
export interface ParsedSession {
  sessionId: string;
  title?: string;
  cwd?: string;
  gitBranch?: string;
  models: string[];
  cliVersion?: string;
  parentSessionId?: string;
  isSubagent?: boolean;
  agentLabel?: string;
  events: NormalizedEvent[];
  measured: MeasuredDurations;
  tokens: TokenUsage;
  /**
   * Token usage keyed by model id. Adapters fill this from whatever the log
   * labels; `core/` is what turns it into money.
   */
  tokensByModel: Record<string, TokenUsage>;
  costUsd?: number;
  /**
   * Per-model cost the provider itself recorded. Like `costUsd`, only ever set
   * when the number was written down — never derived from tokens.
   */
  costByModel?: Record<string, number>;
  providerMeta?: Record<string, unknown>;
  warnings: string[];
  /** Bytes consumed so far; enables append-only incremental re-parsing. */
  bytesConsumed: number;
}

/** Runtime evidence that a session is currently running. */
export interface LiveMarker {
  sessionId: string;
  /** Provider-reported state, e.g. `busy` / `idle`. */
  state?: string;
  updatedAtMs?: number;
  pid?: number;
  pidAlive?: boolean;
  cwd?: string;
  source: string;
}
