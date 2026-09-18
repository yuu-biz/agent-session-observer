import type { Interval } from './types.js';

/**
 * All day bucketing happens in the *viewer's local timezone*, because the
 * question the dashboard answers is "how much did I work today", and "today"
 * is a wall-clock notion. Timestamps themselves are always stored as UTC epoch
 * milliseconds; only bucketing is local.
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** `YYYY-MM-DD` for `ts` in the local timezone. */
export function localDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local midnight (inclusive start) of a `YYYY-MM-DD` key, as epoch ms. */
export function localDayStart(dayKey: string): number {
  const parts = dayKey.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    throw new Error(`invalid day key: ${dayKey}`);
  }
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

/**
 * Local midnight of the *next* day. Built by incrementing the day component so
 * that DST transitions (23h / 25h days) stay correct.
 */
export function localDayEnd(dayKey: string): number {
  const parts = dayKey.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  return new Date(y, m - 1, d + 1, 0, 0, 0, 0).getTime();
}

export function shiftDayKey(dayKey: string, deltaDays: number): string {
  const parts = dayKey.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  return localDayKey(new Date(y, m - 1, d + deltaDays, 12, 0, 0, 0).getTime());
}

/** Inclusive range of day keys, oldest first. */
export function dayKeyRange(fromDayKey: string, toDayKey: string): string[] {
  const out: string[] = [];
  let cur = fromDayKey;
  // Guard against pathological inputs; 10 years of days is plenty.
  for (let i = 0; i < 3700 && cur <= toDayKey; i += 1) {
    out.push(cur);
    cur = shiftDayKey(cur, 1);
  }
  return out;
}

/**
 * Splits intervals at local midnight so that a session running from 23:40 to
 * 00:30 contributes 20 minutes to one day and 30 to the next, rather than
 * landing entirely in whichever day its start happens to fall in.
 */
export function splitIntervalByLocalDay(interval: Interval): Array<{ dayKey: string; interval: Interval }> {
  const out: Array<{ dayKey: string; interval: Interval }> = [];
  if (interval.end < interval.start) return out;

  let cursor = interval.start;
  // Zero-length intervals still belong to exactly one day.
  if (interval.end === interval.start) {
    return [{ dayKey: localDayKey(cursor), interval: { start: cursor, end: cursor } }];
  }

  let guard = 0;
  while (cursor < interval.end && guard < 4000) {
    guard += 1;
    const dayKey = localDayKey(cursor);
    const boundary = localDayEnd(dayKey);
    const end = Math.min(boundary, interval.end);
    out.push({ dayKey, interval: { start: cursor, end } });
    cursor = end;
  }
  return out;
}

export function groupIntervalsByLocalDay(intervals: Interval[]): Map<string, Interval[]> {
  const map = new Map<string, Interval[]>();
  for (const iv of intervals) {
    for (const piece of splitIntervalByLocalDay(iv)) {
      const list = map.get(piece.dayKey);
      if (list) list.push(piece.interval);
      else map.set(piece.dayKey, [piece.interval]);
    }
  }
  return map;
}

/** Parses an ISO-8601 timestamp to epoch ms, or `null` when unusable. */
export function parseIsoTs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic: values below year 2001 in ms are almost certainly seconds.
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value !== 'string' || value.length === 0) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** IANA zone name of the host, used to label the dashboard. */
export function localTimeZoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
  } catch {
    return 'local';
  }
}
