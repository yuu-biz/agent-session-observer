import { describe, expect, it } from 'vitest';

import { summarizeDays, totalsForDays } from '../src/core/aggregate.js';
import { normalizeConfig } from '../src/core/config.js';
import {
  breakdownCost,
  buildRateTable,
  DEFAULT_RATES,
  estimateCacheSavings,
  estimateModelCost,
  rateFor,
} from '../src/core/pricing.js';
import { computeRoi } from '../src/core/roi.js';
import { buildSessionSummary } from '../src/core/session-builder.js';
import type { ParsedSession } from '../src/core/types.js';
import { fakeRoot, fakeSession, localTs } from './helpers.js';

function parsed(overrides: Partial<ParsedSession> = {}): ParsedSession {
  return {
    sessionId: 's1',
    models: [],
    events: [{ ts: localTs(2024, 3, 4, 9), kind: 'user_prompt' }],
    measured: {},
    tokens: {},
    tokensByModel: {},
    warnings: [],
    bytesConsumed: 0,
    ...overrides,
  };
}

describe('rate lookup', () => {
  it('prefers the most specific match', () => {
    expect(rateFor('gpt-5-codex')?.match).toBe('gpt-5-codex');
    expect(rateFor('gpt-5-mini')?.match).toBe('gpt-5-mini');
    expect(rateFor('gpt-5')?.match).toBe('gpt-5');
    expect(rateFor('claude-sonnet-4-6')?.match).toBe('claude-sonnet-4-6');
  });

  it('sees through the decorations model ids arrive with', () => {
    // Date snapshots, context-window tags and gateway prefixes all appear in
    // real logs; none of them should cost a model its price.
    expect(rateFor('claude-opus-4-5-20251101')?.match).toBe('claude-opus-4-5');
    expect(rateFor('claude-opus-5[1m]')?.match).toBe('claude-opus-5');
    expect(rateFor('us.anthropic.claude-sonnet-5')?.match).toBe('claude-sonnet-5');
  });

  it('returns null rather than guessing at an unknown model', () => {
    expect(rateFor('some-local-llama')).toBeNull();
  });
});

describe('cost estimation', () => {
  it('prices each normalized token bucket at its own rate', () => {
    // claude-sonnet-5: $2 input, $10 output, $0.20 cache read, $2.50 cache write.
    const usd = estimateModelCost('claude-sonnet-5', {
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 1_000_000,
    });
    expect(usd).toBeCloseTo(2 + 10 + 0.2 + 2.5, 6);
  });

  it('does not bill reasoning tokens twice', () => {
    const withReasoning = estimateModelCost('gpt-5-codex', { output: 1000, reasoning: 900 });
    const without = estimateModelCost('gpt-5-codex', { output: 1000 });
    expect(withReasoning).toBe(without);
  });

  it('returns null for a model with no rate', () => {
    expect(estimateModelCost('mystery-model', { input: 1000 })).toBeNull();
  });
});

describe('cost breakdown', () => {
  it('prefers a provider-reported figure over its own estimate', () => {
    const result = breakdownCost(
      { 'claude-opus-5': { input: 1_000_000 } },
      { 'claude-opus-5': 1.23 },
    );
    expect(result.models).toEqual([
      { model: 'claude-opus-5', tokens: { input: 1_000_000 }, costUsd: 1.23, basis: 'measured' },
    ]);
    expect(result.measuredUsd).toBe(1.23);
    expect(result.estimatedUsd).toBe(0);
  });

  it('lists an unpriceable model instead of calling it free', () => {
    const result = breakdownCost({ 'mystery-model': { input: 5000 } }, undefined);
    expect(result.unpricedModels).toEqual(['mystery-model']);
    expect(result.models[0]?.basis).toBe('unpriced');
    expect(result.models[0]?.costUsd).toBeUndefined();
    expect(result.estimatedUsd).toBe(0);
  });
});

describe('a session is measured or estimated, never both', () => {
  const root = fakeRoot('claude-code', '/tmp/root');
  const common = {
    root,
    filePath: '/tmp/s.jsonl',
    fileSize: 1,
    fileMtimeMs: localTs(2024, 3, 4, 10),
    idleThresholdMs: 300_000,
    now: localTs(2024, 3, 4, 11),
  };

  it('never adds an estimate on top of a provider-priced session', () => {
    const summary = buildSessionSummary({
      ...common,
      parsed: parsed({
        costUsd: 4.2,
        costByModel: { 'claude-opus-5': 4.2 },
        // A model with usage but no reported cost must not quietly grow the
        // bill past the figure Claude Code itself printed.
        tokensByModel: { 'claude-opus-5': { input: 100 }, 'claude-haiku-4-5': { input: 900 } },
      }),
    });
    expect(summary.costUsd).toBe(4.2);
    expect(summary.estimatedCostUsd).toBeUndefined();
    expect(summary.modelCosts.map((m) => m.basis)).toEqual(['measured']);
  });

  it('estimates when the provider recorded nothing', () => {
    const summary = buildSessionSummary({
      ...common,
      parsed: parsed({ tokensByModel: { 'gpt-5-codex': { input: 1_000_000, output: 100_000 } } }),
    });
    expect(summary.costUsd).toBeUndefined();
    // $1.25/M input + $10/M output.
    expect(summary.estimatedCostUsd).toBeCloseTo(1.25 + 1.0, 6);
    expect(summary.modelCosts[0]?.basis).toBe('estimated');
  });
});

describe('rate overrides', () => {
  it('reprices a family from config without touching the rest', () => {
    const config = normalizeConfig({ modelRates: { 'gpt-5-codex': { input: 0, output: 0 } } });
    const table = buildRateTable(config.modelRates);
    expect(estimateModelCost('gpt-5-codex', { input: 1_000_000, output: 1_000_000 }, table)).toBe(0);
    expect(rateFor('claude-opus-5', table)?.output).toBe(25);
  });

  it('drops a nonsensical rate rather than poisoning every total', () => {
    const config = normalizeConfig({ modelRates: { 'gpt-5': { input: -1, output: Number.NaN } } });
    expect(config.modelRates).toEqual({});
  });

  it('accepts a model the bundled list has never heard of', () => {
    const table = buildRateTable({ 'internal-gateway-model': { input: 1, output: 2 } });
    expect(estimateModelCost('internal-gateway-model', { input: 1_000_000 }, table)).toBe(1);
  });
});

describe('cache savings', () => {
  it('values cached reads at the gap between the two rates', () => {
    // claude-opus-5 reads cache at $0.50/M against $5/M fresh input.
    expect(estimateCacheSavings({ 'claude-opus-5': { cacheRead: 1_000_000 } })).toBeCloseTo(4.5, 6);
  });

  it('ignores a model it cannot price', () => {
    expect(estimateCacheSavings({ unknown: { cacheRead: 1_000_000 } })).toBe(0);
  });
});

describe('unit economics', () => {
  const base = {
    sessionCount: 2,
    userPrompts: 10,
    agentActiveMs: 7_200_000,
    clockActiveMs: 3_600_000,
    toolCalls: 50,
    errors: 1,
    tokens: { input: 100_000, output: 20_000, cacheRead: 900_000 },
    measuredCostUsd: 5,
    estimatedCostUsd: 0,
    hasMeasuredCost: true,
    hasEstimatedCost: false,
  };

  it('divides cost by tasks, sessions and agent-hours', () => {
    const roi = computeRoi(base);
    expect(roi.costPerTaskUsd).toBeCloseTo(0.5, 6);
    expect(roi.costPerSessionUsd).toBeCloseTo(2.5, 6);
    expect(roi.costPerAgentHourUsd).toBeCloseTo(2.5, 6);
  });

  it('reports parallelism as agent time over clock time', () => {
    expect(computeRoi(base).parallelism).toBeCloseTo(2, 6);
  });

  it('measures active time per task, which already excludes idle gaps', () => {
    expect(computeRoi(base).agentMsPerTask).toBe(720_000);
  });

  it('computes the cache hit rate over prompt tokens only', () => {
    expect(computeRoi(base).cacheHitRate).toBeCloseTo(900_000 / 1_000_000, 6);
  });

  it('returns null, not zero, when there is nothing to divide by', () => {
    const roi = computeRoi({ ...base, userPrompts: 0 });
    expect(roi.costPerTaskUsd).toBeNull();
    expect(roi.agentMsPerTask).toBeNull();
    expect(roi.errorsPerHundredTasks).toBeNull();
  });

  it('says so when no cost is known at all', () => {
    const roi = computeRoi({ ...base, measuredCostUsd: 0, hasMeasuredCost: false });
    expect(roi.costBasis).toBe('none');
    expect(roi.costUsd).toBeNull();
    expect(roi.costPerTaskUsd).toBeNull();
  });

  it('marks a range carrying both kinds of figure as mixed', () => {
    const roi = computeRoi({ ...base, estimatedCostUsd: 3, hasEstimatedCost: true });
    expect(roi.costBasis).toBe('mixed');
    expect(roi.costUsd).toBe(8);
  });
});

describe('daily and range rollups', () => {
  const day = localTs(2024, 3, 4, 9);
  const sessions = [
    fakeSession('a', 'claude-code', [{ start: day, end: day + 600_000 }], {
      tokensByModel: { 'claude-opus-5': { input: 1000, output: 500 } },
      costUsd: 2,
      modelCosts: [
        { model: 'claude-opus-5', tokens: { input: 1000, output: 500 }, costUsd: 2, basis: 'measured' },
      ],
    }),
    fakeSession('b', 'codex', [{ start: day + 300_000, end: day + 900_000 }], {
      tokensByModel: { 'gpt-5-codex': { input: 1_000_000 } },
      estimatedCostUsd: 1.25,
      modelCosts: [
        { model: 'gpt-5-codex', tokens: { input: 1_000_000 }, costUsd: 1.25, basis: 'estimated' },
      ],
    }),
  ];

  it('keeps measured and estimated dollars in separate columns', () => {
    const [summary] = summarizeDays(sessions);
    expect(summary?.costUsd).toBe(2);
    expect(summary?.estimatedCostUsd).toBe(1.25);
    expect(summary?.hasCostData).toBe(true);
    expect(summary?.hasEstimatedCost).toBe(true);
  });

  it('labels each model row with where its number came from', () => {
    const totals = totalsForDays(summarizeDays(sessions));
    const byModel = Object.fromEntries(totals.models.map((m) => [m.model, m.basis]));
    expect(byModel).toEqual({ 'claude-opus-5': 'measured', 'gpt-5-codex': 'estimated' });
  });

  it('sorts the model table by spend so the biggest line item leads', () => {
    const totals = totalsForDays(summarizeDays(sessions));
    expect(totals.models[0]?.model).toBe('claude-opus-5');
  });

  it('leaves the bundled list prices untouched by a config with no overrides', () => {
    expect(buildRateTable({})).toBe(DEFAULT_RATES);
  });
});
