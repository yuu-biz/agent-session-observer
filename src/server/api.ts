import {
  summarizeDays,
  totalsForDays,
  type DailySummary,
  type ModelRollup,
  type ProviderBreakdown,
  type RangeTotals,
} from '../core/aggregate.js';
import { assignLanes, computeConcurrency } from '../core/concurrency.js';
import type { AppConfig } from '../core/config.js';
import { clipIntervals } from '../core/activity.js';
import {
  buildRateTable,
  estimateCacheSavings,
  RATES_AS_OF,
  rateFor,
  type ModelRate,
} from '../core/pricing.js';
import { computeRoi, type RoiMetrics } from '../core/roi.js';
import type { RateTable } from '../core/pricing.js';
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
  /** True when this process can shut itself down on request from the page. */
  canQuit: boolean;
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
  /** Unit economics over the whole range, for the headline row. */
  roi: RoiMetrics;
}

/** One day's spend, for the cost trend chart. */
export interface DailyCost {
  dayKey: string;
  measuredUsd: number;
  estimatedUsd: number;
  tasks: number;
  costPerTaskUsd: number | null;
}

export interface ProviderCost extends ProviderBreakdown {
  displayName: string;
  roi: RoiMetrics;
}

/** Everything the Cost screen needs. */
export interface CostResponse {
  days: number;
  roi: RoiMetrics;
  models: ModelRollup[];
  /** Models carrying real usage that no rate covers. Never shown as $0.00. */
  unpricedModels: string[];
  byProvider: ProviderCost[];
  daily: DailyCost[];
  /** Month the bundled price list was last checked. */
  ratesAsOf: string;
  /** False once the user has overridden any rate in their config. */
  usingListPrices: boolean;
  /** The rates actually applied, so the UI can show what it charged. */
  appliedRates: Array<{ model: string; rate: ModelRate }>;
  timezone: string;
}

/**
 * Folds a range's totals into unit economics.
 *
 * Kept here rather than in `core/roi.ts` so that module stays a pure function
 * of plain numbers, with no opinion about where they came from.
 */
function roiFor(totals: RangeTotals, rates: RateTable): RoiMetrics {
  return computeRoi({
    sessionCount: totals.sessionCount,
    userPrompts: totals.userPrompts,
    agentActiveMs: totals.agentActiveMs,
    clockActiveMs: totals.clockActiveMs,
    toolCalls: totals.toolCalls,
    errors: totals.errors,
    tokens: totals.tokens,
    measuredCostUsd: totals.costUsd ?? 0,
    estimatedCostUsd: totals.estimatedCostUsd ?? 0,
    hasMeasuredCost: totals.hasCostData,
    hasEstimatedCost: totals.hasEstimatedCost,
    cacheSavingsUsd: estimateCacheSavings(totals.tokensByModel, rates),
  });
}

function filterByProvider(
  sessions: readonly SessionSummary[],
  provider: ProviderId | 'all',
): SessionSummary[] {
  return provider === 'all' ? [...sessions] : sessions.filter((s) => s.provider === provider);
}

export function buildOverview(
  scanner: SessionScanner,
  options: {
    days: number;
    provider: ProviderId | 'all';
    now: number;
    modelRates?: AppConfig['modelRates'];
  },
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
        tokensByModel: {},
        hasCostData: false,
        hasEstimatedCost: false,
        models: [],
        unpricedModels: [],
        byProvider: [],
        sessionKeys: [],
      },
    );
  }

  const live = sessions
    .filter((s) => s.live.status === 'active' || s.live.status === 'recently_active')
    .sort((a, b) => b.endedAt - a.endedAt)
    .slice(0, 50);

  const totals = totalsForDays(filled);

  return {
    days: filled,
    totals,
    today: byKey.get(todayKey) ?? null,
    timezone: localTimeZoneName(),
    live,
    roi: roiFor(totals, buildRateTable(options.modelRates)),
  };
}

/**
 * The Cost screen.
 *
 * Deliberately a separate endpoint from the overview: it is the one place
 * where a number may be a price-list estimate rather than a provider's own
 * figure, and keeping the two payloads apart makes that boundary visible in
 * the code as well as in the interface.
 */
export function buildCost(
  scanner: SessionScanner,
  options: {
    days: number;
    provider: ProviderId | 'all';
    now: number;
    modelRates?: AppConfig['modelRates'];
  },
): CostResponse {
  const todayKey = localDayKey(options.now);
  const span = Math.max(1, options.days);
  const fromKey = shiftDayKey(todayKey, -(span - 1));
  const keys = dayKeyRange(fromKey, todayKey);
  const wanted = new Set(keys);
  const rates = buildRateTable(options.modelRates);

  const sessions = filterByProvider(scanner.getSessions(), options.provider);
  const days = summarizeDays(sessions).filter((d) => wanted.has(d.dayKey));
  const totals = totalsForDays(days);
  const byDayKey = new Map(days.map((d) => [d.dayKey, d]));

  const daily: DailyCost[] = keys.map((dayKey) => {
    const day = byDayKey.get(dayKey);
    const measuredUsd = day?.costUsd ?? 0;
    const estimatedUsd = day?.estimatedCostUsd ?? 0;
    const tasks = day?.userPrompts ?? 0;
    const total = measuredUsd + estimatedUsd;
    return {
      dayKey,
      measuredUsd,
      estimatedUsd,
      tasks,
      // A day with spend but no prompts (a resumed session, say) has no
      // meaningful per-task figure; null keeps it out of the average.
      costPerTaskUsd: tasks > 0 && total > 0 ? total / tasks : null,
    };
  });

  const byProvider: ProviderCost[] = totals.byProvider.map((pb) => ({
    ...pb,
    displayName: PROVIDER_LIMITS[pb.provider].displayName,
    roi: computeRoi({
      sessionCount: pb.sessionCount,
      userPrompts: pb.userPrompts,
      agentActiveMs: pb.agentActiveMs,
      clockActiveMs: pb.clockActiveMs,
      toolCalls: pb.toolCalls,
      errors: pb.errors,
      tokens: pb.tokens,
      measuredCostUsd: pb.costUsd ?? 0,
      estimatedCostUsd: pb.estimatedCostUsd ?? 0,
      hasMeasuredCost: pb.costUsd !== undefined,
      hasEstimatedCost: pb.estimatedCostUsd !== undefined,
    }),
  }));

  const appliedRates: Array<{ model: string; rate: ModelRate }> = [];
  for (const model of Object.keys(totals.tokensByModel).sort()) {
    const rate = rateFor(model, rates);
    if (!rate) continue;
    appliedRates.push({
      model,
      rate: {
        input: rate.input,
        output: rate.output,
        cacheRead: rate.cacheRead,
        cacheWrite: rate.cacheWrite,
      },
    });
  }

  return {
    days: span,
    roi: roiFor(totals, rates),
    models: totals.models,
    unpricedModels: totals.unpricedModels,
    byProvider,
    daily,
    ratesAsOf: RATES_AS_OF,
    usingListPrices: Object.keys(options.modelRates ?? {}).length === 0,
    appliedRates,
    timezone: localTimeZoneName(),
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
  errors: number;
  tokens: Record<string, number | undefined>;
  costUsd?: number;
  estimatedCostUsd?: number;
  measuredApiMs?: number;
  measuredToolMs?: number;
  /** Unit economics, so the two CLIs are compared per task and not per total. */
  roi: RoiMetrics;
  /** Metrics this provider simply does not record. Shown as "n/a", not zero. */
  unavailable: string[];
}

const PROVIDER_LIMITS: Record<ProviderId, { displayName: string; unavailable: string[] }> = {
  codex: {
    displayName: 'Codex CLI',
    unavailable: [
      'cost in USD (estimated from token counts and a price list instead)',
      'per-session runtime marker (liveness is inferred from log recency)',
    ],
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
    const pb = totals.byProvider.find((p) => p.provider === provider) ?? {
      provider,
      sessionCount: 0,
      agentActiveMs: 0,
      clockActiveMs: 0,
      wallSpanMs: 0,
      toolCalls: 0,
      userPrompts: 0,
      errors: 0,
      tokens: {},
    };
    const limits = PROVIDER_LIMITS[provider];
    return {
      provider,
      displayName: limits.displayName,
      sessionCount: pb.sessionCount,
      agentActiveMs: pb.agentActiveMs,
      clockActiveMs: pb.clockActiveMs,
      toolCalls: pb.toolCalls,
      userPrompts: pb.userPrompts,
      errors: pb.errors,
      tokens: { ...pb.tokens },
      costUsd: pb.costUsd,
      estimatedCostUsd: pb.estimatedCostUsd,
      measuredApiMs: pb.measuredApiMs,
      measuredToolMs: pb.measuredToolMs,
      roi: computeRoi({
        sessionCount: pb.sessionCount,
        userPrompts: pb.userPrompts,
        agentActiveMs: pb.agentActiveMs,
        clockActiveMs: pb.clockActiveMs,
        toolCalls: pb.toolCalls,
        errors: pb.errors,
        tokens: pb.tokens,
        measuredCostUsd: pb.costUsd ?? 0,
        estimatedCostUsd: pb.estimatedCostUsd ?? 0,
        hasMeasuredCost: pb.costUsd !== undefined,
        hasEstimatedCost: pb.estimatedCostUsd !== undefined,
      }),
      unavailable: limits.unavailable,
    };
  });
}
