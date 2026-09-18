import { clipIntervals, sumIntervals, mergeIntervals } from './activity.js';
import { computeConcurrency, computeHourlyBuckets, type HourBucket } from './concurrency.js';
import { localDayEnd, localDayKey, localDayStart, splitIntervalByLocalDay } from './time.js';
import type { Interval, ProviderId, SessionSummary, TokenUsage } from './types.js';

export interface ProviderBreakdown {
  provider: ProviderId;
  sessionCount: number;
  agentActiveMs: number;
  clockActiveMs: number;
  wallSpanMs: number;
  toolCalls: number;
  userPrompts: number;
  tokens: TokenUsage;
  /** Only present when the provider reports real cost. */
  costUsd?: number;
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
  costUsd?: number;
  hasCostData: boolean;
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

  let toolCalls = 0;
  let userPrompts = 0;
  let errors = 0;
  let costUsd = 0;
  let hasCostData = false;

  for (const slice of slices) {
    const s = slice.session;
    const segs = clipIntervals(slice.segments, dayStart, dayEnd);
    const wall = clipIntervals(slice.wallSpan, dayStart, dayEnd);
    allSegments.push(...segs);
    allWall.push(...wall);

    let pb = perProvider.get(s.provider);
    if (!pb) {
      pb = {
        provider: s.provider,
        sessionCount: 0,
        agentActiveMs: 0,
        clockActiveMs: 0,
        wallSpanMs: 0,
        toolCalls: 0,
        userPrompts: 0,
        tokens: emptyTokens(),
      };
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
      toolCalls += s.counters.toolCalls;
      userPrompts += s.counters.userPrompts;
      errors += s.counters.errors;
      addTokens(tokens, s.tokens);
      addTokens(pb.tokens, s.tokens);
      if (typeof s.costUsd === 'number') {
        costUsd += s.costUsd;
        pb.costUsd = (pb.costUsd ?? 0) + s.costUsd;
        hasCostData = true;
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
    costUsd: hasCostData ? costUsd : undefined,
    hasCostData,
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
  tokens: TokenUsage;
  costUsd?: number;
  hasCostData: boolean;
  peakConcurrency: number;
  byProvider: ProviderBreakdown[];
}

/** Totals across a set of daily summaries (e.g. the last 7 days). */
export function totalsForDays(days: readonly DailySummary[]): RangeTotals {
  const tokens = emptyTokens();
  const perProvider = new Map<ProviderId, ProviderBreakdown>();
  let sessionCount = 0;
  let clockActiveMs = 0;
  let agentActiveMs = 0;
  let toolCalls = 0;
  let userPrompts = 0;
  let costUsd = 0;
  let hasCostData = false;
  let peakConcurrency = 0;
  const seenSessions = new Set<string>();

  for (const d of days) {
    for (const key of d.sessionKeys) seenSessions.add(key);
    clockActiveMs += d.clockActiveMs;
    agentActiveMs += d.agentActiveMs;
    toolCalls += d.toolCalls;
    userPrompts += d.userPrompts;
    addTokens(tokens, d.tokens);
    if (d.hasCostData) {
      hasCostData = true;
      costUsd += d.costUsd ?? 0;
    }
    peakConcurrency = Math.max(peakConcurrency, d.peakConcurrency);

    for (const pb of d.byProvider) {
      const cur = perProvider.get(pb.provider) ?? {
        provider: pb.provider,
        sessionCount: 0,
        agentActiveMs: 0,
        clockActiveMs: 0,
        wallSpanMs: 0,
        toolCalls: 0,
        userPrompts: 0,
        tokens: emptyTokens(),
      };
      cur.sessionCount += pb.sessionCount;
      cur.agentActiveMs += pb.agentActiveMs;
      cur.clockActiveMs += pb.clockActiveMs;
      cur.wallSpanMs += pb.wallSpanMs;
      cur.toolCalls += pb.toolCalls;
      cur.userPrompts += pb.userPrompts;
      addTokens(cur.tokens, pb.tokens);
      if (typeof pb.costUsd === 'number') cur.costUsd = (cur.costUsd ?? 0) + pb.costUsd;
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

  return {
    days: days.length,
    sessionCount,
    clockActiveMs,
    agentActiveMs,
    toolCalls,
    userPrompts,
    tokens,
    costUsd: hasCostData ? costUsd : undefined,
    hasCostData,
    peakConcurrency,
    byProvider: [...perProvider.values()].sort((a, b) => a.provider.localeCompare(b.provider)),
  };
}
