import { mergeIntervals, sumIntervals } from './activity.js';
import type { Interval, ProviderId } from './types.js';

/**
 * Concurrency
 * ===========
 *
 * Two different questions, two different numbers, and conflating them is the
 * single easiest way to make an agent dashboard lie:
 *
 *   agentActiveMs  — the SUM of every session's active time. Three agents
 *                    working for 10 minutes each is 30 agent-minutes.
 *   clockActiveMs  — the length of the UNION of those intervals: how much
 *                    wall-clock time had at least one agent working. The same
 *                    three agents, if fully overlapping, is 10 clock-minutes.
 *
 * `avgConcurrency` is `agentActiveMs / clockActiveMs`, i.e. the mean number of
 * agents running *while anything was running at all* — not averaged over the
 * idle parts of the day, which would just measure how long the day is.
 */

export interface LabeledInterval extends Interval {
  sessionKey: string;
  provider: ProviderId;
}

export interface ConcurrencyStep {
  /** Start of this constant-concurrency slice. */
  ts: number;
  count: number;
}

export interface ConcurrencyResult {
  /** Step function over time; `count` holds until the next entry's `ts`. */
  steps: ConcurrencyStep[];
  peak: number;
  /** Start of the first slice where `peak` was reached; `null` if peak is 0. */
  peakAt: number | null;
  /** Total time spent at each concurrency level, keyed by level. */
  msAtLevel: Map<number, number>;
  agentActiveMs: number;
  clockActiveMs: number;
  /** `agentActiveMs / clockActiveMs`, or 0 when nothing was active. */
  avgConcurrency: number;
}

interface SweepPoint {
  ts: number;
  /** -1 processed before +1 at equal timestamps: intervals are half-open. */
  delta: number;
}

export function computeConcurrency(intervals: readonly Interval[]): ConcurrencyResult {
  const points: SweepPoint[] = [];
  for (const iv of intervals) {
    if (!Number.isFinite(iv.start) || !Number.isFinite(iv.end)) continue;
    if (iv.end <= iv.start) continue; // instants add no measurable overlap
    points.push({ ts: iv.start, delta: 1 });
    points.push({ ts: iv.end, delta: -1 });
  }

  const empty: ConcurrencyResult = {
    steps: [],
    peak: 0,
    peakAt: null,
    msAtLevel: new Map(),
    agentActiveMs: 0,
    clockActiveMs: 0,
    avgConcurrency: 0,
  };
  if (points.length === 0) return empty;

  points.sort((a, b) => a.ts - b.ts || a.delta - b.delta);

  const steps: ConcurrencyStep[] = [];
  const msAtLevel = new Map<number, number>();
  let count = 0;
  let peak = 0;
  let peakAt: number | null = null;
  let cursor = points[0]?.ts ?? 0;

  for (let i = 0; i < points.length; ) {
    const ts = (points[i] as SweepPoint).ts;
    if (ts > cursor && count >= 0) {
      const span = ts - cursor;
      if (count > 0) msAtLevel.set(count, (msAtLevel.get(count) ?? 0) + span);
      cursor = ts;
    }
    // Apply every delta at this timestamp before recording the new level.
    while (i < points.length && (points[i] as SweepPoint).ts === ts) {
      count += (points[i] as SweepPoint).delta;
      i += 1;
    }
    const last = steps[steps.length - 1];
    if (!last || last.count !== count) steps.push({ ts, count });
    if (count > peak) {
      peak = count;
      peakAt = ts;
    }
  }

  const agentActiveMs = sumIntervals(intervals.filter((iv) => iv.end > iv.start));
  const clockActiveMs = sumIntervals(mergeIntervals(intervals.filter((iv) => iv.end > iv.start)));

  return {
    steps,
    peak,
    peakAt,
    msAtLevel,
    agentActiveMs,
    clockActiveMs,
    avgConcurrency: clockActiveMs > 0 ? agentActiveMs / clockActiveMs : 0,
  };
}

export interface HourBucket {
  /** 0-23 in local time. */
  hour: number;
  /** Highest concurrency observed anywhere inside the hour. */
  peak: number;
  /** Union of active time inside the hour (<= 3_600_000). */
  clockActiveMs: number;
  /** Sum of per-session active time inside the hour (may exceed the hour). */
  agentActiveMs: number;
}

/**
 * Per-hour buckets for one local day. `dayStart`/`dayEnd` are passed in so DST
 * days (23 or 25 hours) bucket correctly instead of assuming 24 fixed hours.
 */
export function computeHourlyBuckets(
  intervals: readonly Interval[],
  dayStart: number,
  dayEnd: number,
): HourBucket[] {
  const buckets: HourBucket[] = [];
  const hours = Math.max(1, Math.round((dayEnd - dayStart) / 3_600_000));
  for (let h = 0; h < hours; h += 1) {
    const from = dayStart + h * 3_600_000;
    const to = Math.min(dayEnd, from + 3_600_000);
    const clipped: Interval[] = [];
    for (const iv of intervals) {
      const s = Math.max(iv.start, from);
      const e = Math.min(iv.end, to);
      if (e > s) clipped.push({ start: s, end: e });
    }
    const res = computeConcurrency(clipped);
    buckets.push({
      hour: h,
      peak: res.peak,
      clockActiveMs: res.clockActiveMs,
      agentActiveMs: res.agentActiveMs,
    });
  }
  return buckets;
}

/**
 * Assigns each session to a lane so that no two sessions in the same lane
 * overlap, which is what a readable Gantt-style timeline needs.
 */
export function assignLanes(
  items: ReadonlyArray<{ key: string; start: number; end: number }>,
): Map<string, number> {
  const sorted = items.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const laneEnds: number[] = [];
  const lanes = new Map<string, number>();

  for (const item of sorted) {
    let placed = false;
    for (let lane = 0; lane < laneEnds.length; lane += 1) {
      if ((laneEnds[lane] as number) <= item.start) {
        laneEnds[lane] = item.end;
        lanes.set(item.key, lane);
        placed = true;
        break;
      }
    }
    if (!placed) {
      laneEnds.push(item.end);
      lanes.set(item.key, laneEnds.length - 1);
    }
  }
  return lanes;
}
