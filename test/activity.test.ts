import { describe, expect, it } from 'vitest';

import {
  clampIdleThreshold,
  clipIntervals,
  computeActivity,
  computeSegments,
  gapsBetween,
  mergeIntervals,
  sumIntervals,
} from '../src/core/activity.js';
import { ev, t } from './helpers.js';

const MIN = 60_000;

describe('computeSegments', () => {
  it('returns one segment when every gap is within the threshold', () => {
    const ts = [0, 60_000, 120_000, 180_000];
    expect(computeSegments(ts, 5 * MIN)).toEqual([{ start: 0, end: 180_000 }]);
  });

  it('splits at gaps strictly greater than the threshold', () => {
    const ts = [0, 60_000, 60_000 + 5 * MIN + 1, 60_000 + 6 * MIN];
    const segments = computeSegments(ts, 5 * MIN);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({ start: 0, end: 60_000 });
  });

  it('treats a gap exactly equal to the threshold as continuous', () => {
    expect(computeSegments([0, 5 * MIN], 5 * MIN)).toEqual([{ start: 0, end: 5 * MIN }]);
  });

  it('sorts unordered input and ignores non-finite values', () => {
    expect(computeSegments([200, 100, Number.NaN, 300], 5 * MIN)).toEqual([
      { start: 100, end: 300 },
    ]);
  });

  it('produces a zero-length segment for a single event', () => {
    expect(computeSegments([500], 5 * MIN)).toEqual([{ start: 500, end: 500 }]);
  });

  it('returns nothing for no events', () => {
    expect(computeSegments([], 5 * MIN)).toEqual([]);
  });
});

describe('computeActivity', () => {
  it('reports active time as the sum of segments and idle as the remainder', () => {
    const events = [
      // a burst of activity: 09:00 -> 09:10, no gap wider than the threshold
      ev('2024-03-04T09:00:00Z'),
      ev('2024-03-04T09:03:00Z'),
      ev('2024-03-04T09:07:00Z'),
      ev('2024-03-04T09:10:00Z'),
      // 40 minutes of nothing
      ev('2024-03-04T09:50:00Z'),
      ev('2024-03-04T09:53:00Z'),
      ev('2024-03-04T09:55:00Z'),
    ];
    const activity = computeActivity(events, 5 * MIN);

    expect(activity.segments).toHaveLength(2);
    expect(activity.activeMs).toBe(15 * MIN); // 10 + 5
    expect(activity.idleMs).toBe(40 * MIN);
    expect(activity.idleGaps).toHaveLength(1);
    expect(activity.idleGaps[0]?.durationMs).toBe(40 * MIN);
  });

  it('never reports active time greater than the wall span', () => {
    const events = [ev('2024-03-04T09:00:00Z'), ev('2024-03-04T11:00:00Z')];
    const activity = computeActivity(events, 24 * 60 * MIN);
    const wall = t('2024-03-04T11:00:00Z') - t('2024-03-04T09:00:00Z');
    expect(activity.activeMs).toBeLessThanOrEqual(wall);
  });

  it('is monotone in the idle threshold: a larger threshold never shrinks active time', () => {
    const events = [
      ev('2024-03-04T09:00:00Z'),
      ev('2024-03-04T09:02:00Z'),
      ev('2024-03-04T09:20:00Z'),
      ev('2024-03-04T09:21:00Z'),
      ev('2024-03-04T10:30:00Z'),
    ];
    let previous = -1;
    for (const minutes of [1, 5, 15, 30, 60]) {
      const active = computeActivity(events, minutes * MIN).activeMs;
      expect(active).toBeGreaterThanOrEqual(previous);
      previous = active;
    }
  });

  it('records the threshold it was computed with', () => {
    expect(computeActivity([ev('2024-03-04T09:00:00Z')], 7 * MIN).idleThresholdMs).toBe(7 * MIN);
  });
});

describe('clampIdleThreshold', () => {
  it('clamps absurd values instead of trusting them', () => {
    expect(clampIdleThreshold(0)).toBe(10_000);
    expect(clampIdleThreshold(999 * 60 * MIN)).toBe(60 * MIN);
    expect(clampIdleThreshold(Number.NaN)).toBe(5 * MIN);
  });
});

describe('interval helpers', () => {
  it('merges overlapping and touching intervals', () => {
    expect(
      mergeIntervals([
        { start: 0, end: 10 },
        { start: 10, end: 20 },
        { start: 30, end: 40 },
        { start: 5, end: 8 },
      ]),
    ).toEqual([
      { start: 0, end: 20 },
      { start: 30, end: 40 },
    ]);
  });

  it('sums interval lengths, ignoring inverted ones', () => {
    expect(
      sumIntervals([
        { start: 0, end: 10 },
        { start: 20, end: 15 },
      ]),
    ).toBe(10);
  });

  it('clips to a window and drops what falls outside', () => {
    expect(
      clipIntervals(
        [
          { start: 0, end: 100 },
          { start: 200, end: 300 },
        ],
        50,
        250,
      ),
    ).toEqual([
      { start: 50, end: 100 },
      { start: 200, end: 250 },
    ]);
  });

  it('gapsBetween returns one fewer entry than there are segments', () => {
    const segments = [
      { start: 0, end: 10 },
      { start: 100, end: 110 },
      { start: 300, end: 310 },
    ];
    expect(gapsBetween(segments)).toHaveLength(2);
    expect(gapsBetween([{ start: 0, end: 1 }])).toEqual([]);
  });
});
