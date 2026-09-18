import { describe, expect, it } from 'vitest';

import { summarizeDays, totalsForDays } from '../src/core/aggregate.js';
import {
  dayKeyRange,
  localDayEnd,
  localDayKey,
  localDayStart,
  parseIsoTs,
  shiftDayKey,
  splitIntervalByLocalDay,
} from '../src/core/time.js';
import { fakeSession, localTs } from './helpers.js';

const MIN = 60_000;
const HOUR = 3_600_000;

describe('local day keys', () => {
  it('round-trips a key through start and back', () => {
    const key = '2024-03-04';
    expect(localDayKey(localDayStart(key))).toBe(key);
    expect(localDayKey(localDayEnd(key) - 1)).toBe(key);
  });

  it('starts the next day exactly where the previous one ends', () => {
    expect(localDayEnd('2024-03-04')).toBe(localDayStart('2024-03-05'));
  });

  it('is computed in local time, not UTC', () => {
    // 23:30 local always belongs to that local day, whatever the offset is.
    const ts = localTs(2024, 3, 4, 23, 30);
    expect(localDayKey(ts)).toBe('2024-03-04');
  });

  it('handles month and year rollover', () => {
    expect(shiftDayKey('2024-02-28', 1)).toBe('2024-02-29'); // leap year
    expect(shiftDayKey('2024-02-29', 1)).toBe('2024-03-01');
    expect(shiftDayKey('2024-12-31', 1)).toBe('2025-01-01');
    expect(shiftDayKey('2024-01-01', -1)).toBe('2023-12-31');
  });

  it('measures a day as 22-26 hours, covering DST transitions', () => {
    // Every day in a year must have a plausible length whatever the host zone.
    for (const key of dayKeyRange('2024-03-01', '2024-11-30')) {
      const length = localDayEnd(key) - localDayStart(key);
      expect(length).toBeGreaterThanOrEqual(22 * HOUR);
      expect(length).toBeLessThanOrEqual(26 * HOUR);
    }
  });

  it('builds an inclusive range', () => {
    expect(dayKeyRange('2024-03-04', '2024-03-06')).toEqual([
      '2024-03-04',
      '2024-03-05',
      '2024-03-06',
    ]);
    expect(dayKeyRange('2024-03-06', '2024-03-04')).toEqual([]);
  });
});

describe('splitIntervalByLocalDay', () => {
  it('splits a session that runs across midnight', () => {
    const start = localTs(2024, 3, 4, 23, 40);
    const end = localTs(2024, 3, 5, 0, 30);
    const pieces = splitIntervalByLocalDay({ start, end });

    expect(pieces).toHaveLength(2);
    const [first, second] = pieces;
    expect(first?.dayKey).toBe('2024-03-04');
    expect((first?.interval.end ?? 0) - (first?.interval.start ?? 0)).toBe(20 * MIN);
    expect(second?.dayKey).toBe('2024-03-05');
    expect((second?.interval.end ?? 0) - (second?.interval.start ?? 0)).toBe(30 * MIN);
  });

  it('conserves total duration across the split', () => {
    const start = localTs(2024, 3, 3, 22, 0);
    const end = localTs(2024, 3, 6, 4, 0);
    const pieces = splitIntervalByLocalDay({ start, end });
    const total = pieces.reduce((sum, p) => sum + (p.interval.end - p.interval.start), 0);
    expect(total).toBe(end - start);
  });

  it('keeps an instant in exactly one day', () => {
    const ts = localTs(2024, 3, 4, 12, 0);
    const pieces = splitIntervalByLocalDay({ start: ts, end: ts });
    expect(pieces).toHaveLength(1);
    expect(pieces[0]?.dayKey).toBe('2024-03-04');
  });

  it('drops an inverted interval instead of looping', () => {
    expect(splitIntervalByLocalDay({ start: 1000, end: 0 })).toEqual([]);
  });
});

describe('parseIsoTs', () => {
  it('parses ISO strings and epoch numbers, and rejects junk', () => {
    expect(parseIsoTs('2024-03-04T09:00:00.000Z')).toBe(Date.UTC(2024, 2, 4, 9));
    expect(parseIsoTs(1_709_542_800_000)).toBe(1_709_542_800_000);
    expect(parseIsoTs(1_709_542_800)).toBe(1_709_542_800_000); // seconds promoted
    expect(parseIsoTs('not a date')).toBeNull();
    expect(parseIsoTs(undefined)).toBeNull();
    expect(parseIsoTs({})).toBeNull();
  });
});

describe('daily aggregation', () => {
  it('attributes the right slice of a midnight-crossing session to each day', () => {
    const session = fakeSession('s1', 'codex', [
      { start: localTs(2024, 3, 4, 23, 40), end: localTs(2024, 3, 5, 0, 30) },
    ]);
    const days = summarizeDays([session]);

    expect(days.map((d) => d.dayKey)).toEqual(['2024-03-04', '2024-03-05']);
    expect(days[0]?.agentActiveMs).toBe(20 * MIN);
    expect(days[1]?.agentActiveMs).toBe(30 * MIN);
  });

  it('counts a session once per day it touches', () => {
    const session = fakeSession('s1', 'codex', [
      { start: localTs(2024, 3, 4, 23, 40), end: localTs(2024, 3, 5, 0, 30) },
    ]);
    const days = summarizeDays([session]);
    expect(days.every((d) => d.sessionCount === 1)).toBe(true);
  });

  it('attributes per-session counters to the start day so they still sum correctly', () => {
    const session = fakeSession('s1', 'codex', [
      { start: localTs(2024, 3, 4, 23, 40), end: localTs(2024, 3, 5, 0, 30) },
    ]);
    const days = summarizeDays([session]);
    expect(days[0]?.toolCalls).toBe(2);
    expect(days[1]?.toolCalls).toBe(0);
  });

  it('computes peak and average concurrency per day', () => {
    const day = 2024;
    const sessions = [
      fakeSession('a', 'codex', [{ start: localTs(day, 3, 4, 9, 0), end: localTs(day, 3, 4, 9, 20) }]),
      fakeSession('b', 'claude-code', [
        { start: localTs(day, 3, 4, 9, 5), end: localTs(day, 3, 4, 9, 40) },
      ]),
      fakeSession('c', 'codex', [{ start: localTs(day, 3, 4, 9, 12), end: localTs(day, 3, 4, 9, 30) }]),
    ];
    const days = summarizeDays(sessions);
    const d = days[0];

    expect(d?.peakConcurrency).toBe(3);
    expect(d?.clockActiveMs).toBe(40 * MIN);
    expect(d?.agentActiveMs).toBe(73 * MIN);
    expect(d?.avgConcurrency).toBeCloseTo(73 / 40, 6);
  });

  it('breaks a day down per provider with each provider getting its own union', () => {
    const sessions = [
      fakeSession('a', 'codex', [{ start: localTs(2024, 3, 4, 9, 0), end: localTs(2024, 3, 4, 9, 30) }]),
      fakeSession('b', 'codex', [{ start: localTs(2024, 3, 4, 9, 10), end: localTs(2024, 3, 4, 9, 20) }]),
      fakeSession('c', 'claude-code', [
        { start: localTs(2024, 3, 4, 10, 0), end: localTs(2024, 3, 4, 10, 15) },
      ]),
    ];
    const day = summarizeDays(sessions)[0];
    const codex = day?.byProvider.find((p) => p.provider === 'codex');

    expect(codex?.agentActiveMs).toBe(40 * MIN); // 30 + 10, overlapping
    expect(codex?.clockActiveMs).toBe(30 * MIN); // union is just the outer one
    expect(day?.byProvider.find((p) => p.provider === 'claude-code')?.sessionCount).toBe(1);
  });

  it('reports cost only when a provider actually recorded it', () => {
    const withCost = fakeSession('a', 'claude-code', [
      { start: localTs(2024, 3, 4, 9, 0), end: localTs(2024, 3, 4, 9, 10) },
    ], { costUsd: 1.5 });
    const withoutCost = fakeSession('b', 'codex', [
      { start: localTs(2024, 3, 4, 9, 0), end: localTs(2024, 3, 4, 9, 10) },
    ]);

    expect(summarizeDays([withoutCost])[0]?.hasCostData).toBe(false);
    expect(summarizeDays([withoutCost])[0]?.costUsd).toBeUndefined();

    const both = summarizeDays([withCost, withoutCost])[0];
    expect(both?.hasCostData).toBe(true);
    expect(both?.costUsd).toBeCloseTo(1.5, 6);
  });
});

describe('range totals', () => {
  it('counts a session spanning two days only once', () => {
    const session = fakeSession('s1', 'codex', [
      { start: localTs(2024, 3, 4, 23, 40), end: localTs(2024, 3, 5, 0, 30) },
    ]);
    const totals = totalsForDays(summarizeDays([session]));
    expect(totals.sessionCount).toBe(1);
    expect(totals.agentActiveMs).toBe(50 * MIN);
  });

  it('takes the maximum daily peak, not the sum', () => {
    const sessions = [
      fakeSession('a', 'codex', [{ start: localTs(2024, 3, 4, 9, 0), end: localTs(2024, 3, 4, 9, 30) }]),
      fakeSession('b', 'codex', [{ start: localTs(2024, 3, 4, 9, 5), end: localTs(2024, 3, 4, 9, 25) }]),
      fakeSession('c', 'codex', [{ start: localTs(2024, 3, 5, 9, 0), end: localTs(2024, 3, 5, 9, 30) }]),
    ];
    const totals = totalsForDays(summarizeDays(sessions));
    expect(totals.peakConcurrency).toBe(2);
  });
});
