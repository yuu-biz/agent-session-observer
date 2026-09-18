import { summarizeDays, totalsForDays, type DailySummary, type RangeTotals } from '../core/aggregate.js';
import { assignLanes, computeConcurrency } from '../core/concurrency.js';
import type { AppConfig } from '../core/config.js';
import { clipIntervals } from '../core/activity.js';
import {
  dayKeyRange,
  localDayEnd,
  localDayKey,
  localDayStart,
  localTimeZoneName,
  shiftDayKey,
} from '../core/time.js';
import type { DiscoveryRoot, Interval, ProviderId, SessionSummary } from '../core/types.js';
import type { ScanProgress, SessionScanner } from '../indexer/scanner.js';

/**
 * API shapes.
 *
 * The web UI reads only these types, never provider-native records, which is
 * what keeps the "adapters are replaceable" boundary real rather than aspirational.
 */

export interface StatusResponse {
  scanning: boolean;
  progress: ScanProgress | null;
  scannedAt: number | null;
  durationMs: number | null;
  filesScanned: number;
  filesParsed: number;
  sessionCount: number;
  duplicateCount: number;
  roots: DiscoveryRoot[];
  notes: string[];
  warnings: string[];
  timezone: string;
  today: string;
  config: AppConfig;
  version: string;
  /** Always true. Stated explicitly so the UI can show it. */
  localOnly: true;
}

export interface SessionLane extends SessionSummary {
  lane: number;
  /** Segments clipped to the requested day, for timeline rendering. */
  daySegments: Interval[];
  dayWallSpan: Interval | null;
}

export interface DayResponse {
  dayKey: string;
  dayStart: number;
  dayEnd: number;
  summary: DailySummary | null;
  sessions: SessionLane[];
  concurrencySteps: Array<{ ts: number; count: number }>;
  timezone: string;
}

export interface OverviewResponse {
  days: DailySummary[];
  totals: RangeTotals;
  today: DailySummary | null;
  timezone: string;
  /** Sessions whose evidence suggests they may still be running. */
  live: SessionSummary[];
}

function filterByProvider(
  sessions: readonly SessionSummary[],
  provider: ProviderId | 'all',
): SessionSummary[] {
  return provider === 'all' ? [...sessions] : sessions.filter((s) => s.provider === provider);
}

export function buildOverview(
  scanner: SessionScanner,
  options: { days: number; provider: ProviderId | 'all'; now: number },
): OverviewResponse {
  const todayKey = localDayKey(options.now);
  const fromKey = shiftDayKey(todayKey, -(Math.max(1, options.days) - 1));
  const wanted = new Set(dayKeyRange(fromKey, todayKey));

  const sessions = filterByProvider(scanner.getSessions(), options.provider);
  const allDays = summarizeDays(sessions);
  const days = allDays.filter((d) => wanted.has(d.dayKey));

  // Days with no activity still belong in the chart, as zeroes.
  const byKey = new Map(days.map((d) => [d.dayKey, d]));
  const filled: DailySummary[] = [];
  for (const key of dayKeyRange(fromKey, todayKey)) {
    const found = byKey.get(key);
    filled.push(
      found ?? {
        dayKey: key,
        dayStart: localDayStart(key),
        dayEnd: localDayEnd(key),
        sessionCount: 0,
        clockActiveMs: 0,
        agentActiveMs: 0,
        wallSpanMs: 0,
        firstActivityTs: null,
        lastActivityTs: null,
        peakConcurrency: 0,
        peakConcurrencyAt: null,
        avgConcurrency: 0,
        msAtConcurrency: [],
        hourly: [],
        toolCalls: 0,
        userPrompts: 0,
        errors: 0,
        tokens: {},
        hasCostData: false,
        byProvider: [],
        sessionKeys: [],
      },
    );
  }

  const live = sessions
    .filter((s) => s.live.status === 'active' || s.live.status === 'recently_active')
    .sort((a, b) => b.endedAt - a.endedAt)
    .slice(0, 50);

  return {
    days: filled,
    totals: totalsForDays(filled),
    today: byKey.get(todayKey) ?? null,
    timezone: localTimeZoneName(),
    live,
  };
}

export function buildDay(
  scanner: SessionScanner,
  options: { dayKey: string; provider: ProviderId | 'all' },
): DayResponse {
  const dayStart = localDayStart(options.dayKey);
  const dayEnd = localDayEnd(options.dayKey);
  const sessions = filterByProvider(scanner.getSessions(), options.provider).filter(
    (s) => s.endedAt >= dayStart && s.startedAt < dayEnd,
  );

  const summaries = summarizeDays(sessions);
  const summary = summaries.find((d) => d.dayKey === options.dayKey) ?? null;

  const laneInput = sessions.map((s) => ({
    key: s.key,
    start: Math.max(s.startedAt, dayStart),
    end: Math.min(s.endedAt, dayEnd),
  }));
  const lanes = assignLanes(laneInput);

  const withLanes: SessionLane[] = sessions.map((s) => {
    const start = Math.max(s.startedAt, dayStart);
    const end = Math.min(s.endedAt, dayEnd);
    return {
      ...s,
      lane: lanes.get(s.key) ?? 0,
      daySegments: clipIntervals(s.activity.segments, dayStart, dayEnd),
      dayWallSpan: end >= start ? { start, end } : null,
    };
  });

  const allSegments = withLanes.flatMap((s) => s.daySegments);
  const conc = computeConcurrency(allSegments);

  return {
    dayKey: options.dayKey,
    dayStart,
    dayEnd,
    summary,
    sessions: withLanes.sort((a, b) => a.startedAt - b.startedAt),
    concurrencySteps: conc.steps,
    timezone: localTimeZoneName(),
  };
}

export interface ProviderComparison {
  provider: ProviderId;
  displayName: string;
  sessionCount: number;
  agentActiveMs: number;
  clockActiveMs: number;
  toolCalls: number;
  userPrompts: number;
  tokens: Record<string, number | undefined>;
  costUsd?: number;
  measuredApiMs?: number;
  measuredToolMs?: number;
  /** Metrics this provider simply does not record. Shown as "n/a", not zero. */
  unavailable: string[];
}

const PROVIDER_LIMITS: Record<ProviderId, { displayName: string; unavailable: string[] }> = {
  codex: {
    displayName: 'Codex CLI',
    unavailable: ['cost in USD', 'per-session runtime marker (liveness is inferred from log recency)'],
  },
  'claude-code': {
    displayName: 'Claude Code',
    unavailable: ['per-turn time-to-first-token'],
  },
};

export function buildComparison(
  scanner: SessionScanner,
  options: { days: number; now: number },
): ProviderComparison[] {
  const todayKey = localDayKey(options.now);
  const fromKey = shiftDayKey(todayKey, -(Math.max(1, options.days) - 1));
  const wanted = new Set(dayKeyRange(fromKey, todayKey));

  const days = summarizeDays([...scanner.getSessions()]).filter((d) => wanted.has(d.dayKey));
  const totals = totalsForDays(days);

  return (['codex', 'claude-code'] as ProviderId[]).map((provider) => {
    const pb = totals.byProvider.find((p) => p.provider === provider);
    const limits = PROVIDER_LIMITS[provider];
    return {
      provider,
      displayName: limits.displayName,
      sessionCount: pb?.sessionCount ?? 0,
      agentActiveMs: pb?.agentActiveMs ?? 0,
      clockActiveMs: pb?.clockActiveMs ?? 0,
      toolCalls: pb?.toolCalls ?? 0,
      userPrompts: pb?.userPrompts ?? 0,
      tokens: { ...(pb?.tokens ?? {}) },
      costUsd: pb?.costUsd,
      measuredApiMs: pb?.measuredApiMs,
      measuredToolMs: pb?.measuredToolMs,
      unavailable: limits.unavailable,
    };
  });
}
