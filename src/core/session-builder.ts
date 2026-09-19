import { computeActivity } from './activity.js';
import { computeLiveState } from './liveness.js';
import { breakdownCost, DEFAULT_RATES, type ModelCost, type RateTable } from './pricing.js';
import { oneLine } from './tools.js';
import type {
  DiscoveryRoot,
  LiveMarker,
  NormalizedEvent,
  ParsedSession,
  SessionCounters,
  SessionDetail,
  SessionPhase,
  SessionSummary,
  TokenUsage,
} from './types.js';

/**
 * Turns adapter output into the normalized session record the rest of the app
 * consumes. All threshold-dependent analysis lives here so that changing the
 * idle threshold only requires rebuilding summaries, never re-parsing logs.
 */

export interface BuildSessionInput {
  parsed: ParsedSession;
  root: DiscoveryRoot;
  filePath: string;
  fileSize: number;
  fileMtimeMs: number;
  idleThresholdMs: number;
  marker?: LiveMarker | undefined;
  now: number;
  /** Price list used for cost estimates. Omitted in tests that ignore cost. */
  rates?: RateTable;
}

interface CostSplit {
  modelCosts: ModelCost[];
  estimatedCostUsd?: number;
  unpricedModels: string[];
}

/**
 * Splits a session's spend into per-model rows.
 *
 * A session is measured or estimated, never both. When the provider priced the
 * session itself, this app does not second-guess any part of it: the rows come
 * straight from the provider's own per-model figures, and no estimate is
 * produced at all. Only when nothing was written down does the price list run.
 *
 * Mixing the two would produce a total that is partly a fact and partly a
 * guess, which is the one thing the cost columns exist to prevent.
 */
function splitCost(parsed: ParsedSession, rates: RateTable): CostSplit {
  // A cache entry written by an older build can arrive without this map.
  const tokensByModel = parsed.tokensByModel ?? {};
  if (parsed.costUsd !== undefined) {
    const measured = parsed.costByModel ?? {};
    const modelCosts: ModelCost[] = Object.keys(measured)
      .sort()
      .map((model) => ({
        model,
        tokens: tokensByModel[model] ?? {},
        costUsd: measured[model],
        basis: 'measured' as const,
      }));
    return { modelCosts, unpricedModels: [] };
  }

  const breakdown = breakdownCost(tokensByModel, undefined, rates);
  return {
    modelCosts: breakdown.models,
    estimatedCostUsd: breakdown.estimatedUsd > 0 ? breakdown.estimatedUsd : undefined,
    unpricedModels: breakdown.unpricedModels,
  };
}

function countEvents(events: readonly NormalizedEvent[]): SessionCounters {
  const c: SessionCounters = {
    events: events.length,
    userPrompts: 0,
    assistantMessages: 0,
    toolCalls: 0,
    errors: 0,
    compactions: 0,
  };
  for (const e of events) {
    switch (e.kind) {
      case 'user_prompt':
        c.userPrompts += 1;
        break;
      case 'assistant_message':
        c.assistantMessages += 1;
        break;
      case 'tool_call':
        c.toolCalls += 1;
        break;
      case 'error':
        c.errors += 1;
        break;
      case 'compaction':
        c.compactions += 1;
        break;
      default:
        break;
    }
  }
  return c;
}

function addTokens(target: TokenUsage, src: TokenUsage | undefined): void {
  if (!src) return;
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total'] as const) {
    const v = src[k];
    if (typeof v === 'number' && Number.isFinite(v)) target[k] = (target[k] ?? 0) + v;
  }
}

export function buildSessionSummary(input: BuildSessionInput): SessionSummary {
  const { parsed, root, filePath, fileSize, fileMtimeMs, idleThresholdMs, marker, now } = input;
  const cost = splitCost(parsed, input.rates ?? DEFAULT_RATES);

  const events = parsed.events.slice().sort((a, b) => a.ts - b.ts);
  const first = events[0];
  const last = events[events.length - 1];
  const startedAt = first ? first.ts : fileMtimeMs;
  const endedAt = last ? last.ts : fileMtimeMs;

  const activity = computeActivity(events, idleThresholdMs);
  const counters = countEvents(events);

  const live = computeLiveState({
    lastEventTs: endedAt,
    fileMtimeMs,
    marker,
    now,
  });

  return {
    key: `${root.provider}:${parsed.sessionId}`,
    provider: root.provider,
    sessionId: parsed.sessionId,
    host: root.host,
    rootId: root.id,
    filePath,
    fileSize,
    fileMtimeMs,
    title: parsed.title,
    cwd: parsed.cwd,
    gitBranch: parsed.gitBranch,
    models: parsed.models,
    cliVersion: parsed.cliVersion,
    parentSessionId: parsed.parentSessionId,
    parentSessionKey: parsed.parentSessionId
      ? `${root.provider}:${parsed.parentSessionId}`
      : undefined,
    isSubagent: parsed.isSubagent,
    agentLabel: parsed.agentLabel,
    startedAt,
    endedAt,
    wallSpanMs: Math.max(0, endedAt - startedAt),
    activity,
    measured: parsed.measured,
    counters,
    tokens: parsed.tokens,
    tokensByModel: parsed.tokensByModel ?? {},
    costUsd: parsed.costUsd,
    estimatedCostUsd: cost.estimatedCostUsd,
    modelCosts: cost.modelCosts,
    unpricedModels: cost.unpricedModels,
    live,
    providerMeta: parsed.providerMeta,
  };
}

/**
 * Splits a session into phases: one per user prompt, running until the next
 * user prompt. Work that happens before the first prompt (system setup,
 * resumed context) becomes phase 0 labelled "session setup".
 */
export function computePhases(events: readonly NormalizedEvent[]): SessionPhase[] {
  const phases: SessionPhase[] = [];
  let current: SessionPhase | null = null;

  const push = (): void => {
    if (current) phases.push(current);
  };

  for (const e of events) {
    if (e.kind === 'user_prompt') {
      push();
      current = {
        index: phases.length,
        startTs: e.ts,
        endTs: e.ts,
        title: oneLine(e.summary) || '(empty prompt)',
        toolCalls: 0,
        tokens: {},
      };
      continue;
    }
    if (!current) {
      current = {
        index: 0,
        startTs: e.ts,
        endTs: e.ts,
        title: 'session setup',
        toolCalls: 0,
        tokens: {},
      };
    }
    current.endTs = Math.max(current.endTs, e.ts);
    if (e.kind === 'tool_call') current.toolCalls += 1;
    if (e.tokens) addTokens(current.tokens as TokenUsage, e.tokens);
  }
  push();

  // Re-index so indices are contiguous even when phase 0 was synthesised.
  return phases.map((p, i) => ({ ...p, index: i }));
}

export const MAX_DETAIL_EVENTS = 20_000;

export function buildSessionDetail(
  summary: SessionSummary,
  events: readonly NormalizedEvent[],
  maxEvents = MAX_DETAIL_EVENTS,
): SessionDetail {
  const sorted = events.slice().sort((a, b) => a.ts - b.ts);
  const truncated = sorted.length > maxEvents;
  return {
    ...summary,
    phases: computePhases(sorted),
    events: truncated ? sorted.slice(0, maxEvents) : sorted,
    eventsTruncated: truncated,
  };
}
