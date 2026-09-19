import type { ProviderId, TokenUsage } from './types.js';

/**
 * Cost estimation from token counts.
 *
 * This is the one place in the app allowed to turn tokens into money, and it
 * lives in `core/` rather than in an adapter on purpose: an adapter reports
 * only what the provider wrote down, so a price list has no business inside
 * one. Anything produced here is an **estimate** and is carried in its own
 * field (`estimatedCostUsd`) so it can never be mistaken for the measured
 * `costUsd` a provider recorded.
 *
 * Why estimate at all: Claude Code writes its own dollar figure, Codex writes
 * none. Leaving the Codex column blank made the cheaper-looking provider the
 * one that simply says less, which is worse than a clearly labelled estimate.
 *
 * The rates below are public list prices as of the date in `RATES_AS_OF`. They
 * go stale, they ignore volume discounts, and they ignore the fact that a
 * subscription plan may already cover the usage. Override them in
 * `~/.agent-session-observer/config.json` under `modelRates` to bill against
 * what your organisation actually pays.
 */

/** Date the bundled price list was last checked, shown in the UI. */
export const RATES_AS_OF = '2026-05';

/** USD per 1,000,000 tokens. */
export interface ModelRate {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface RateEntry extends ModelRate {
  /** Lower-case substring matched against the model id. Longest match wins. */
  match: string;
  provider: ProviderId;
}

/**
 * Anthropic prompt caching is billed at 0.1x input to read and 1.25x input to
 * write (5-minute TTL), so those columns are derived rather than remembered.
 */
function anthropic(match: string, input: number, output: number): RateEntry {
  return {
    match,
    provider: 'claude-code',
    input,
    output,
    cacheRead: Number((input * 0.1).toFixed(4)),
    cacheWrite: Number((input * 1.25).toFixed(4)),
  };
}

/** OpenAI bills cached input at 0.1x and does not charge to populate a cache. */
function openai(match: string, input: number, output: number): RateEntry {
  return {
    match,
    provider: 'codex',
    input,
    output,
    cacheRead: Number((input * 0.1).toFixed(4)),
    cacheWrite: 0,
  };
}

export const DEFAULT_RATES: readonly RateEntry[] = [
  // ---- Anthropic, as used by Claude Code -------------------------------
  anthropic('claude-fable-5', 10, 50),
  anthropic('claude-mythos-5', 10, 50),
  anthropic('claude-opus-5', 5, 25),
  anthropic('claude-opus-4-8', 5, 25),
  anthropic('claude-opus-4-7', 5, 25),
  anthropic('claude-opus-4-6', 5, 25),
  anthropic('claude-opus-4-5', 5, 25),
  anthropic('claude-opus-4-1', 15, 75),
  anthropic('claude-opus-4', 15, 75),
  anthropic('claude-sonnet-5', 2, 10),
  anthropic('claude-sonnet-4-6', 3, 15),
  anthropic('claude-sonnet-4-5', 3, 15),
  anthropic('claude-sonnet-4', 3, 15),
  anthropic('claude-3-7-sonnet', 3, 15),
  anthropic('claude-haiku-4-5', 1, 5),
  anthropic('claude-3-5-haiku', 0.8, 4),
  anthropic('claude-3-haiku', 0.25, 1.25),

  // ---- OpenAI, as used by Codex CLI ------------------------------------
  openai('gpt-5.1-codex-max', 1.25, 10),
  openai('gpt-5.1-codex-mini', 0.25, 2),
  openai('gpt-5.1-codex', 1.25, 10),
  openai('gpt-5.1', 1.25, 10),
  openai('gpt-5-codex', 1.25, 10),
  openai('gpt-5-mini', 0.25, 2),
  openai('gpt-5-nano', 0.05, 0.4),
  openai('gpt-5', 1.25, 10),
  openai('gpt-4.1-mini', 0.4, 1.6),
  openai('gpt-4.1', 2, 8),
  openai('codex-mini', 1.5, 6),
  openai('o4-mini', 1.1, 4.4),
  openai('o3-mini', 1.1, 4.4),
  openai('o3', 2, 8),
];

/**
 * Model ids arrive decorated: a date suffix (`-20251101`), a context-window
 * tag (`[1m]`), or a gateway prefix (`us.anthropic.`). Matching on a
 * normalized substring survives all three without a rule per shape.
 */
export function normalizeModelId(model: string): string {
  return model.trim().toLowerCase().replace(/\[[^\]]*\]/g, '');
}

export type RateTable = readonly RateEntry[];

/**
 * Merges user overrides over the bundled list. An override key is matched the
 * same way a built-in entry is, so `"gpt-5"` reprices the whole family and
 * `"gpt-5-codex"` reprices just that model.
 */
export function buildRateTable(overrides?: Record<string, Partial<ModelRate>>): RateTable {
  if (!overrides || Object.keys(overrides).length === 0) return DEFAULT_RATES;

  const table = DEFAULT_RATES.map((entry) => {
    const override = overrides[entry.match];
    return override ? { ...entry, ...override } : entry;
  });

  for (const [match, rate] of Object.entries(overrides)) {
    if (table.some((e) => e.match === match)) continue;
    if (typeof rate.input !== 'number' || typeof rate.output !== 'number') continue;
    table.push({
      match: match.toLowerCase(),
      // A model nobody recognises is priced regardless of which CLI ran it.
      provider: match.toLowerCase().startsWith('claude') ? 'claude-code' : 'codex',
      input: rate.input,
      output: rate.output,
      cacheRead: rate.cacheRead ?? rate.input * 0.1,
      cacheWrite: rate.cacheWrite ?? 0,
    });
  }
  return table;
}

/** The most specific entry matching `model`, or `null` when nothing does. */
export function rateFor(model: string, table: RateTable = DEFAULT_RATES): RateEntry | null {
  const id = normalizeModelId(model);
  let best: RateEntry | null = null;
  for (const entry of table) {
    if (!id.includes(entry.match)) continue;
    if (!best || entry.match.length > best.match.length) best = entry;
  }
  return best;
}

/** Cost of one model's usage, in USD. `null` when the model has no rate. */
export function estimateModelCost(
  model: string,
  tokens: TokenUsage,
  table: RateTable = DEFAULT_RATES,
): number | null {
  const rate = rateFor(model, table);
  if (!rate) return null;

  // The normalized buckets are disjoint (see `TokenUsage`), so each is simply
  // multiplied by its own rate. Reasoning tokens are a subset of output in both
  // providers' accounting and are deliberately not added again.
  const cacheRead = tokens.cacheRead ?? 0;
  const cacheWrite = tokens.cacheWrite ?? 0;
  const input = tokens.input ?? 0;
  const output = tokens.output ?? 0;

  const usd =
    (input * rate.input +
      output * rate.output +
      cacheRead * rate.cacheRead +
      cacheWrite * rate.cacheWrite) /
    1_000_000;

  return Number.isFinite(usd) ? usd : null;
}

/** One model's contribution to a session's or a day's bill. */
export interface ModelCost {
  model: string;
  tokens: TokenUsage;
  /** Omitted when the model has no known rate and the provider reported none. */
  costUsd?: number;
  /**
   * `measured` — the provider wrote this number down.
   * `estimated` — tokens x the price list.
   * `unpriced` — usage exists but no rate is known; never rendered as zero.
   */
  basis: 'measured' | 'estimated' | 'unpriced';
}

export interface CostBreakdown {
  models: ModelCost[];
  /** Sum of the `measured` rows. */
  measuredUsd: number;
  /** Sum of the `estimated` rows. */
  estimatedUsd: number;
  /** Models carrying tokens that nothing could price. */
  unpricedModels: string[];
}

/**
 * Splits token usage per model into measured and estimated cost.
 *
 * `measuredByModel` wins wherever the provider supplied a figure; everything
 * else falls through to the price list. A session can legitimately end up with
 * both, which is why the two sums are returned separately.
 */
export function breakdownCost(
  tokensByModel: Readonly<Record<string, TokenUsage>>,
  measuredByModel: Readonly<Record<string, number>> | undefined,
  table: RateTable = DEFAULT_RATES,
): CostBreakdown {
  const models: ModelCost[] = [];
  const unpricedModels: string[] = [];
  let measuredUsd = 0;
  let estimatedUsd = 0;

  const names = new Set([...Object.keys(tokensByModel), ...Object.keys(measuredByModel ?? {})]);
  for (const model of [...names].sort()) {
    const tokens = tokensByModel[model] ?? {};
    const measured = measuredByModel?.[model];
    if (typeof measured === 'number' && Number.isFinite(measured)) {
      measuredUsd += measured;
      models.push({ model, tokens, costUsd: measured, basis: 'measured' });
      continue;
    }
    const estimate = estimateModelCost(model, tokens, table);
    if (estimate === null) {
      unpricedModels.push(model);
      models.push({ model, tokens, basis: 'unpriced' });
      continue;
    }
    estimatedUsd += estimate;
    models.push({ model, tokens, costUsd: estimate, basis: 'estimated' });
  }

  return { models, measuredUsd, estimatedUsd, unpricedModels };
}

/**
 * What prompt caching saved, in USD.
 *
 * Cached input is billed at a fraction of fresh input, so the saving is the
 * difference between the two rates over the tokens that were read from cache.
 * For a long agent session this is routinely the largest single line item, and
 * it is invisible in a plain token count — which is exactly why it is worth
 * showing next to the bill.
 *
 * Always an estimate, even for a session whose total cost was measured: no
 * provider writes down the counterfactual.
 */
export function estimateCacheSavings(
  tokensByModel: Readonly<Record<string, TokenUsage>>,
  table: RateTable = DEFAULT_RATES,
): number {
  let saved = 0;
  for (const [model, tokens] of Object.entries(tokensByModel)) {
    const rate = rateFor(model, table);
    if (!rate) continue;
    const cacheRead = tokens.cacheRead ?? 0;
    saved += (cacheRead * Math.max(0, rate.input - rate.cacheRead)) / 1_000_000;
  }
  return saved;
}
