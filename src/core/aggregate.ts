import { clipIntervals, sumIntervals, mergeIntervals } from './activity.js';
import { computeConcurrency, computeHourlyBuckets, type HourBucket } from './concurrency.js';
import { localDayEnd, localDayKey, localDayStart, splitIntervalByLocalDay } from './time.js';
import type { Interval, ModelCost, ProviderId, SessionSummary, TokenUsage } from './types.js';

/** One model's share of a day's or a range's work. */
export interface ModelRollup {
  model: string;
  provider: ProviderId;
  tokens: TokenUsage;
  sessions: number;
  /** Dollars the provider wrote down for this model. */
  measuredUsd: number;
  /** Dollars derived from tokens and the price list. */
  estimatedUsd: number;
  /**
   * `unpriced` means real token usage that nothing could put a number on. It is
   * a distinct outcome from "no usage" and must not render as $0.00.
   */
  basis: 'measured' | 'estimated' | 'unpriced' | 'mixed';
}

export interface ProviderBreakdown {
  provider: ProviderId;
  sessionCount: number;
  agentActiveMs: number;
  clockActiveMs: number;
  wallSpanMs: number;
  toolCalls: number;
  userPrompts: number;
  errors: number;
  tokens: TokenUsage;
  /** Only present when the provider reports real cost. */
  costUsd?: number;
  /** Only present when this app priced the tokens itself. */
  estimatedCostUsd?: number;
  /** Provider-measured API time, when available. */
  measuredApiMs?: number;
  measuredToolMs?: number;
}

export interface DailySummary {
  dayKey: string;
  dayStart: number;
  dayEnd: number;
  sessionCount: number;
  /** Union of all sessions' active segments: wall-clock time with >=1 agent. */
  clockActiveMs: number;
  /** Sum of all sessions' active time. Can exceed `clockActiveMs`. */
  agentActiveMs: number;
  /** Union of session wall spans clipped to the day. */
  wallSpanMs: number;
  /** First and last activity of the day, local. */
  firstActivityTs: number | null;
  lastActivityTs: number | null;
  peakConcurrency: number;
  peakConcurrencyAt: number | null;
  avgConcurrency: number;
  /** Wall-clock ms spent at each concurrency level (1, 2, 3 ...). */
  msAtConcurrency: Array<{ level: number; ms: number }>;
  hourly: HourBucket[];
  toolCalls: number;
  userPrompts: number;
  errors: number;
  tokens: TokenUsage;
  tokensByModel: Record<string, TokenUsage>;
  costUsd?: number;
  hasCostData: boolean;
  estimatedCostUsd?: number;
  hasEstimatedCost: boolean;
  models: ModelRollup[];
  /** Models with usage that no rate covers, so the bill is known to be short. */
  unpricedModels: string[];
  byProvider: ProviderBreakdown[];
  sessionKeys: string[];
}

function addTokens(target: TokenUsage, src: TokenUsage | undefined): void {
  if (!src) return;
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total'] as const) {
    const v = src[k];
    if (typeof v === 'number' && Number.isFinite(v)) target[k] = (target[k] ?? 0) + v;
  }
}

function emptyTokens(): TokenUsage {
  return {};
}

function emptyProvider(provider: ProviderId): ProviderBreakdown {
  return {
    provider,
    sessionCount: 0,
    agentActiveMs: 0,
    clockActiveMs: 0,
    wallSpanMs: 0,
    toolCalls: 0,
    userPrompts: 0,
    errors: 0,
    tokens: emptyTokens(),
  };
}

/**
 * Accumulates per-model usage across sessions.
 *
 * A model is keyed by name alone: the same id never appears under two
 * providers in practice, and splitting it would scatter one line item across
 * the report.
 */
class ModelAccumulator {
  private readonly rows = new Map<string, ModelRollup>();

  add(session: SessionSummary): void {
    const costs = new Map<string, ModelCost>();
    for (const row of session.modelCosts) costs.set(row.model, row);

    const names = new Set([...Object.keys(session.tokensByModel), ...costs.keys()]);
    for (const model of names) {
      let row = this.rows.get(model);
      if (!row) {
        row = {
          model,
          provider: session.provider,
          tokens: emptyTokens(),
          sessions: 0,
          measuredUsd: 0,
          estimatedUsd: 0,
          basis: 'unpriced',
        };
        this.rows.set(model, row);
      }
      row.sessions += 1;
      addTokens(row.tokens, session.tokensByModel[model]);

      const cost = costs.get(model);
      if (!cost || cost.costUsd === undefined) continue;
      if (cost.basis === 'measured') row.measuredUsd += cost.costUsd;
      else if (cost.basis === 'estimated') row.estimatedUsd += cost.costUsd;
    }
  }

  result(): ModelRollup[] {
    for (const row of this.rows.values()) {
      const measured = row.measuredUsd > 0;
      const estimated = row.estimatedUsd > 0;
      row.basis = measured && estimated ? 'mixed' : measured ? 'measured' : estimated ? 'estimated' : 'unpriced';
    }
    // Biggest line item first: this table is read to find what to act on.
    return [...this.rows.values()].sort(
      (a, b) => b.measuredUsd + b.estimatedUsd - (a.measuredUsd + a.estimatedUsd) ||
        a.model.localeCompare(b.model),
    );
  }
}

/** Per-day slices of one session's active segments and wall span. */
export interface DaySlice {
  session: SessionSummary;
  segments: Interval[];
  wallSpan: Interval[];
}

function sliceByDay(sessions: readonly SessionSummary[]): Map<string, DaySlice[]> {
  const byDay = new Map<string, Map<string, DaySlice>>();

  const ensure = (dayKey: string, session: SessionSummary): DaySlice => {
    let day = byDay.get(dayKey);
    if (!day) {
      day = new Map();
      byDay.set(dayKey, day);
    }
    let slice = day.get(session.key);
    if (!slice) {
      slice = { session, segments: [], wallSpan: [] };
      day.set(session.key, slice);
    }
    return slice;
  };

  for (const s of sessions) {
    for (const seg of s.activity.segments) {
      for (const piece of splitIntervalByLocalDay(seg)) {
        ensure(piece.dayKey, s).segments.push(piece.interval);
      }
    }
    for (const piece of splitIntervalByLocalDay({ start: s.startedAt, end: s.endedAt })) {
      ensure(piece.dayKey, s).wallSpan.push(piece.interval);
    }
    // A session with no events at all still belongs to its start day.
    if (s.activity.segments.length === 0) ensure(localDayKey(s.startedAt), s);
  }

  const out = new Map<string, DaySlice[]>();
  for (const [dayKey, map] of byDay) out.set(dayKey, [...map.values()]);
  return out;
}

export function summarizeDay(dayKey: string, slices: readonly DaySlice[]): DailySummary {
  const dayStart = localDayStart(dayKey);
  const dayEnd = localDayEnd(dayKey);

  const allSegments: Interval[] = [];
  const allWall: Interval[] = [];
  const perProvider = new Map<ProviderId, ProviderBreakdown>();
  const tokens = emptyTokens();
  const tokensByModel: Record<string, TokenUsage> = {};
  const models = new ModelAccumulator();
  const unpriced = new Set<string>();

  let toolCalls = 0;
  let userPrompts = 0;
  let errors = 0;
  let costUsd = 0;
  let hasCostData = false;
  let estimatedCostUsd = 0;
  let hasEstimatedCost = false;

  for (const slice of slices) {
    const s = slice.session;
    const segs = clipIntervals(slice.segments, dayStart, dayEnd);
    const wall = clipIntervals(slice.wallSpan, dayStart, dayEnd);
    allSegments.push(...segs);
    allWall.push(...wall);

    let pb = perProvider.get(s.provider);
    if (!pb) {
      pb = emptyProvider(s.provider);
      perProvider.set(s.provider, pb);
    }
    pb.sessionCount += 1;
    pb.agentActiveMs += sumIntervals(segs);
    pb.wallSpanMs += sumIntervals(wall);

    // Counters and totals are per-session, not per-day-slice: attributing them
    // to the day a session *started* keeps them summing to the session total.
    const startsToday = localDayKey(s.startedAt) === dayKey;
    if (startsToday) {
      pb.toolCalls += s.counters.toolCalls;
      pb.userPrompts += s.counters.userPrompts;
      pb.errors += s.counters.errors;
      toolCalls += s.counters.toolCalls;
      userPrompts += s.counters.userPrompts;
      errors += s.counters.errors;
      addTokens(tokens, s.tokens);
      addTokens(pb.tokens, s.tokens);
      for (const [model, usage] of Object.entries(s.tokensByModel)) {
        addTokens((tokensByModel[model] ??= {}), usage);
      }
      models.add(s);
      for (const model of s.unpricedModels) unpriced.add(model);
      if (typeof s.costUsd === 'number') {
        costUsd += s.costUsd;
        pb.costUsd = (pb.costUsd ?? 0) + s.costUsd;
        hasCostData = true;
      }
      if (typeof s.estimatedCostUsd === 'number') {
        estimatedCostUsd += s.estimatedCostUsd;
        pb.estimatedCostUsd = (pb.estimatedCostUsd ?? 0) + s.estimatedCostUsd;
        hasEstimatedCost = true;
      }
      if (typeof s.measured.apiMs === 'number') {
        pb.measuredApiMs = (pb.measuredApiMs ?? 0) + s.measured.apiMs;
      }
      if (typeof s.measured.toolMs === 'number') {
        pb.measuredToolMs = (pb.measuredToolMs ?? 0) + s.measured.toolMs;
      }
    }
  }

  // Per-provider clock time needs its own union, computed from that provider only.
  for (const [provider, pb] of perProvider) {
    const segs: Interval[] = [];
    for (const slice of slices) {
      if (slice.session.provider !== provider) continue;
      segs.push(...clipIntervals(slice.segments, dayStart, dayEnd));
    }
    pb.clockActiveMs = sumIntervals(mergeIntervals(segs));
  }

  const conc = computeConcurrency(allSegments);
  const merged = mergeIntervals(allSegments);
  const first = merged[0];
  const last = merged[merged.length - 1];

  const msAtConcurrency = [...conc.msAtLevel.entries()]
    .map(([level, ms]) => ({ level, ms }))
    .sort((a, b) => a.level - b.level);

  return {
    dayKey,
    dayStart,
    dayEnd,
    sessionCount: slices.length,
    clockActiveMs: conc.clockActiveMs,
    agentActiveMs: conc.agentActiveMs,
    wallSpanMs: sumIntervals(mergeIntervals(allWall)),
    firstActivityTs: first ? first.start : null,
    lastActivityTs: last ? last.end : null,
    peakConcurrency: conc.peak,
    peakConcurrencyAt: conc.peakAt,
    avgConcurrency: conc.avgConcurrency,
    msAtConcurrency,
    hourly: computeHourlyBuckets(allSegments, dayStart, dayEnd),
    toolCalls,
    userPrompts,
    errors,
    tokens,
    tokensByModel,
    costUsd: hasCostData ? costUsd : undefined,
    hasCostData,
    estimatedCostUsd: hasEstimatedCost ? estimatedCostUsd : undefined,
    hasEstimatedCost,
    models: models.result(),
    unpricedModels: [...unpriced].sort(),
    byProvider: [...perProvider.values()].sort((a, b) => a.provider.localeCompare(b.provider)),
    sessionKeys: slices.map((s) => s.session.key),
  };
}

/** Builds one `DailySummary` per day touched by any session. */
export function summarizeDays(sessions: readonly SessionSummary[]): DailySummary[] {
  const byDay = sliceByDay(sessions);
  return [...byDay.entries()]
    .map(([dayKey, slices]) => summarizeDay(dayKey, slices))
    .sort((a, b) => a.dayKey.localeCompare(b.dayKey));
}

export interface RangeTotals {
  days: number;
  sessionCount: number;
  clockActiveMs: number;
  agentActiveMs: number;
  toolCalls: number;
  userPrompts: number;
  errors: number;
  tokens: TokenUsage;
  tokensByModel: Record<string, TokenUsage>;
  costUsd?: number;
  hasCostData: boolean;
  estimatedCostUsd?: number;
  hasEstimatedCost: boolean;
  models: ModelRollup[];
  unpricedModels: string[];
  peakConcurrency: number;
  byProvider: ProviderBreakdown[];
}

/** Totals across a set of daily summaries (e.g. the last 7 days). */
export function totalsForDays(days: readonly DailySummary[]): RangeTotals {
  const tokens = emptyTokens();
  const tokensByModel: Record<string, TokenUsage> = {};
  const perProvider = new Map<ProviderId, ProviderBreakdown>();
  const modelRows = new Map<string, ModelRollup>();
  const unpriced = new Set<string>();
  let sessionCount = 0;
  let clockActiveMs = 0;
  let agentActiveMs = 0;
  let toolCalls = 0;
  let userPrompts = 0;
  let errors = 0;
  let costUsd = 0;
  let hasCostData = false;
  let estimatedCostUsd = 0;
  let hasEstimatedCost = false;
  let peakConcurrency = 0;
  const seenSessions = new Set<string>();

  for (const d of days) {
    for (const key of d.sessionKeys) seenSessions.add(key);
    clockActiveMs += d.clockActiveMs;
    agentActiveMs += d.agentActiveMs;
    toolCalls += d.toolCalls;
    userPrompts += d.userPrompts;
    errors += d.errors;
    addTokens(tokens, d.tokens);
    for (const [model, usage] of Object.entries(d.tokensByModel)) {
      addTokens((tokensByModel[model] ??= {}), usage);
    }
    for (const model of d.unpricedModels) unpriced.add(model);
    if (d.hasCostData) {
      hasCostData = true;
      costUsd += d.costUsd ?? 0;
    }
    if (d.hasEstimatedCost) {
      hasEstimatedCost = true;
      estimatedCostUsd += d.estimatedCostUsd ?? 0;
    }
    peakConcurrency = Math.max(peakConcurrency, d.peakConcurrency);

    for (const row of d.models) {
      const cur = modelRows.get(row.model) ?? {
        model: row.model,
        provider: row.provider,
        tokens: emptyTokens(),
        sessions: 0,
        measuredUsd: 0,
        estimatedUsd: 0,
        basis: 'unpriced' as ModelRollup['basis'],
      };
      addTokens(cur.tokens, row.tokens);
      cur.sessions += row.sessions;
      cur.measuredUsd += row.measuredUsd;
      cur.estimatedUsd += row.estimatedUsd;
      modelRows.set(row.model, cur);
    }

    for (const pb of d.byProvider) {
      const cur = perProvider.get(pb.provider) ?? emptyProvider(pb.provider);
      cur.sessionCount += pb.sessionCount;
      cur.agentActiveMs += pb.agentActiveMs;
      cur.clockActiveMs += pb.clockActiveMs;
      cur.wallSpanMs += pb.wallSpanMs;
      cur.toolCalls += pb.toolCalls;
      cur.userPrompts += pb.userPrompts;
      cur.errors += pb.errors;
      addTokens(cur.tokens, pb.tokens);
      if (typeof pb.costUsd === 'number') cur.costUsd = (cur.costUsd ?? 0) + pb.costUsd;
      if (typeof pb.estimatedCostUsd === 'number') {
        cur.estimatedCostUsd = (cur.estimatedCostUsd ?? 0) + pb.estimatedCostUsd;
      }
      if (typeof pb.measuredApiMs === 'number') {
        cur.measuredApiMs = (cur.measuredApiMs ?? 0) + pb.measuredApiMs;
      }
      if (typeof pb.measuredToolMs === 'number') {
        cur.measuredToolMs = (cur.measuredToolMs ?? 0) + pb.measuredToolMs;
      }
      perProvider.set(pb.provider, cur);
    }
  }

  sessionCount = seenSessions.size;

  const models = [...modelRows.values()].map((row) => {
    const measured = row.measuredUsd > 0;
    const estimated = row.estimatedUsd > 0;
    return {
      ...row,
      basis: (measured && estimated
        ? 'mixed'
        : measured
          ? 'measured'
          : estimated
            ? 'estimated'
            : 'unpriced') as ModelRollup['basis'],
    };
  });
  models.sort(
    (a, b) =>
      b.measuredUsd + b.estimatedUsd - (a.measuredUsd + a.estimatedUsd) ||
      a.model.localeCompare(b.model),
  );

  return {
    days: days.length,
    sessionCount,
    clockActiveMs,
    agentActiveMs,
    toolCalls,
    userPrompts,
    errors,
    tokens,
    tokensByModel,
    costUsd: hasCostData ? costUsd : undefined,
    hasCostData,
    estimatedCostUsd: hasEstimatedCost ? estimatedCostUsd : undefined,
    hasEstimatedCost,
    models,
    unpricedModels: [...unpriced].sort(),
    peakConcurrency,
    byProvider: [...perProvider.values()].sort((a, b) => a.provider.localeCompare(b.provider)),
  };
}
