import { describe, expect, it } from 'vitest';

import { assignLanes, computeConcurrency, computeHourlyBuckets } from '../src/core/concurrency.js';
import { localTs } from './helpers.js';

const MIN = 60_000;

/** The worked example from the product brief, in local time. */
function briefIntervals(): Array<{ start: number; end: number }> {
  return [
    { start: localTs(2024, 3, 4, 9, 0), end: localTs(2024, 3, 4, 9, 20) }, // Codex A
    { start: localTs(2024, 3, 4, 9, 5), end: localTs(2024, 3, 4, 9, 40) }, // Claude B
    { start: localTs(2024, 3, 4, 9, 12), end: localTs(2024, 3, 4, 9, 30) }, // Codex C
  ];
}

describe('computeConcurrency', () => {
  it('finds peak 3 for the three-session example', () => {
    const result = computeConcurrency(briefIntervals());
    expect(result.peak).toBe(3);
    expect(result.peakAt).toBe(localTs(2024, 3, 4, 9, 12));
  });

  it('separates summed agent time from wall-clock time', () => {
    const result = computeConcurrency(briefIntervals());
    // 20 + 35 + 18 minutes of agent time
    expect(result.agentActiveMs).toBe(73 * MIN);
    // the union runs 09:00 -> 09:40
    expect(result.clockActiveMs).toBe(40 * MIN);
    expect(result.avgConcurrency).toBeCloseTo(73 / 40, 6);
  });

  it('accounts for every millisecond of clock time across levels', () => {
    const result = computeConcurrency(briefIntervals());
    const total = [...result.msAtLevel.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(result.clockActiveMs);
  });

  it('reports the right time at each level', () => {
    const result = computeConcurrency(briefIntervals());
    expect(result.msAtLevel.get(1)).toBe(15 * MIN); // 09:00-09:05 and 09:30-09:40
    expect(result.msAtLevel.get(2)).toBe(17 * MIN); // 09:05-09:12 and 09:20-09:30
    expect(result.msAtLevel.get(3)).toBe(8 * MIN); //  09:12-09:20
  });

  it('treats intervals as half-open, so touching intervals never overlap', () => {
    const result = computeConcurrency([
      { start: 0, end: 100 },
      { start: 100, end: 200 },
    ]);
    expect(result.peak).toBe(1);
    expect(result.clockActiveMs).toBe(200);
    expect(result.agentActiveMs).toBe(200);
  });

  it('ignores zero-length intervals, which add no measurable overlap', () => {
    const result = computeConcurrency([
      { start: 0, end: 0 },
      { start: 10, end: 20 },
    ]);
    expect(result.peak).toBe(1);
    expect(result.clockActiveMs).toBe(10);
  });

  it('returns zeroes for no input', () => {
    const result = computeConcurrency([]);
    expect(result).toMatchObject({ peak: 0, peakAt: null, clockActiveMs: 0, avgConcurrency: 0 });
  });

  it('handles fully nested intervals', () => {
    const result = computeConcurrency([
      { start: 0, end: 1000 },
      { start: 200, end: 400 },
      { start: 250, end: 300 },
    ]);
    expect(result.peak).toBe(3);
    expect(result.clockActiveMs).toBe(1000);
    expect(result.agentActiveMs).toBe(1000 + 200 + 50);
  });
});

describe('computeHourlyBuckets', () => {
  it('buckets by hour and never reports more than an hour of clock time per bucket', () => {
    const dayStart = localTs(2024, 3, 4, 0, 0);
    const dayEnd = localTs(2024, 3, 5, 0, 0);
    const buckets = computeHourlyBuckets(briefIntervals(), dayStart, dayEnd);

    expect(buckets).toHaveLength(24);
    const nine = buckets.find((b) => b.hour === 9);
    expect(nine?.peak).toBe(3);
    expect(nine?.clockActiveMs).toBe(40 * MIN);
    for (const b of buckets) expect(b.clockActiveMs).toBeLessThanOrEqual(60 * MIN);
  });

  it('splits an interval that crosses an hour boundary', () => {
    const dayStart = localTs(2024, 3, 4, 0, 0);
    const dayEnd = localTs(2024, 3, 5, 0, 0);
    const buckets = computeHourlyBuckets(
      [{ start: localTs(2024, 3, 4, 9, 45), end: localTs(2024, 3, 4, 10, 15) }],
      dayStart,
      dayEnd,
    );
    expect(buckets.find((b) => b.hour === 9)?.clockActiveMs).toBe(15 * MIN);
    expect(buckets.find((b) => b.hour === 10)?.clockActiveMs).toBe(15 * MIN);
  });
});

describe('assignLanes', () => {
  it('puts overlapping sessions in different lanes', () => {
    const lanes = assignLanes([
      { key: 'a', start: 0, end: 100 },
      { key: 'b', start: 50, end: 150 },
      { key: 'c', start: 60, end: 80 },
    ]);
    expect(new Set([lanes.get('a'), lanes.get('b'), lanes.get('c')]).size).toBe(3);
  });

  it('reuses a lane once it is free', () => {
    const lanes = assignLanes([
      { key: 'a', start: 0, end: 100 },
      { key: 'b', start: 100, end: 200 },
    ]);
    expect(lanes.get('a')).toBe(0);
    expect(lanes.get('b')).toBe(0);
  });
});
