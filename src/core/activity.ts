import type { ActivityEstimate, IdleGap, Interval, NormalizedEvent } from './types.js';

/**
 * Activity semantics
 * ==================
 *
 * A session log gives us discrete event timestamps, never a continuous "the
 * agent was busy" signal. So this module is deliberately explicit about what
 * is measured and what is estimated:
 *
 *   wall span     = last event - first event.  A FACT about the log.
 *   active time   = sum of "segments".         An ESTIMATE, and a lower bound.
 *   idle time     = wall span - active time.   Derived from the estimate.
 *
 * A *segment* is a maximal run of consecutive events where no two neighbours
 * are further apart than `idleThresholdMs`. Its duration is `last - first`
 * within the run, so the work done after the final event of a segment is not
 * counted. That makes `activeMs` a conservative lower bound, which is the
 * honest direction to err in: a dashboard that over-reports working time is
 * worse than one that under-reports it.
 *
 * What this is NOT: it is not model compute time. A two hour session does not
 * mean two hours of inference. `MeasuredDurations` carries the provider's own
 * API/tool timings when the log contains them, and the UI shows those
 * separately.
 */

export const DEFAULT_IDLE_THRESHOLD_MS = 5 * 60_000;
export const MIN_IDLE_THRESHOLD_MS = 10_000;
export const MAX_IDLE_THRESHOLD_MS = 60 * 60_000;

export function clampIdleThreshold(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_IDLE_THRESHOLD_MS;
  return Math.min(MAX_IDLE_THRESHOLD_MS, Math.max(MIN_IDLE_THRESHOLD_MS, Math.round(ms)));
}

/**
 * Groups sorted timestamps into segments split at gaps > `idleThresholdMs`.
 * Input need not be sorted; it is copied and sorted here.
 */
export function computeSegments(timestamps: readonly number[], idleThresholdMs: number): Interval[] {
  const ts = timestamps.filter((t) => Number.isFinite(t)).slice().sort((a, b) => a - b);
  if (ts.length === 0) return [];

  const threshold = clampIdleThreshold(idleThresholdMs);
  const segments: Interval[] = [];
  let start = ts[0] as number;
  let prev = start;

  for (let i = 1; i < ts.length; i += 1) {
    const t = ts[i] as number;
    if (t - prev > threshold) {
      segments.push({ start, end: prev });
      start = t;
    }
    prev = t;
  }
  segments.push({ start, end: prev });
  return segments;
}

export function sumIntervals(intervals: readonly Interval[]): number {
  let total = 0;
  for (const iv of intervals) total += Math.max(0, iv.end - iv.start);
  return total;
}

/** Gaps strictly larger than the threshold, i.e. the spaces between segments. */
export function gapsBetween(segments: readonly Interval[]): IdleGap[] {
  const gaps: IdleGap[] = [];
  for (let i = 1; i < segments.length; i += 1) {
    const prev = segments[i - 1] as Interval;
    const cur = segments[i] as Interval;
    gaps.push({ start: prev.end, end: cur.start, durationMs: cur.start - prev.end });
  }
  return gaps;
}

export function computeActivity(
  events: readonly NormalizedEvent[],
  idleThresholdMs: number,
): ActivityEstimate {
  const threshold = clampIdleThreshold(idleThresholdMs);
  const segments = computeSegments(
    events.map((e) => e.ts),
    threshold,
  );
  const activeMs = sumIntervals(segments);
  const first = segments[0];
  const last = segments[segments.length - 1];
  const wallSpanMs = first && last ? last.end - first.start : 0;

  return {
    idleThresholdMs: threshold,
    segments,
    activeMs,
    idleMs: Math.max(0, wallSpanMs - activeMs),
    idleGaps: gapsBetween(segments),
  };
}

/** Merges overlapping/touching intervals. Input is not mutated. */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals
    .filter((iv) => Number.isFinite(iv.start) && Number.isFinite(iv.end) && iv.end >= iv.start)
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (sorted.length === 0) return [];

  const out: Interval[] = [];
  let cur = { ...(sorted[0] as Interval) };
  for (let i = 1; i < sorted.length; i += 1) {
    const iv = sorted[i] as Interval;
    if (iv.start <= cur.end) {
      if (iv.end > cur.end) cur.end = iv.end;
    } else {
      out.push(cur);
      cur = { ...iv };
    }
  }
  out.push(cur);
  return out;
}

/** Restricts intervals to `[start, end)`, dropping anything fully outside. */
export function clipIntervals(intervals: readonly Interval[], start: number, end: number): Interval[] {
  const out: Interval[] = [];
  for (const iv of intervals) {
    const s = Math.max(iv.start, start);
    const e = Math.min(iv.end, end);
    if (e > s) out.push({ start: s, end: e });
    else if (e === s && iv.start === iv.end && iv.start >= start && iv.start < end) {
      // Preserve instant events so single-event sessions remain visible.
      out.push({ start: s, end: e });
    }
  }
  return out;
}
