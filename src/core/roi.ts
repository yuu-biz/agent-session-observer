import type { TokenUsage } from './types.js';

/**
 * Unit-economics metrics.
 *
 * Everything here is a ratio derived from numbers computed elsewhere: this
 * module measures nothing itself and adds no new source of truth. It exists
 * because totals answer "what did we spend" and almost nobody is asking that —
 * they are asking what a unit of work costs, and whether that is moving.
 *
 * The unit of work is a **task**: one user prompt and the agent's response to
 * it, up to the next prompt. It is the closest thing in a session log to "a
 * thing someone asked for", it needs no configuration, and both providers
 * record it the same way. It is also coarse: a prompt can be "fix the typo" or
 * "port the service to gRPC", so per-task figures are meaningful compared
 * against each other over time, not as an absolute.
 *
 * Every field is nullable, and null means "not enough data to divide", never
 * zero. A day with no prompts has no cost per task; showing $0.00 there would
 * be a lie that averages straight into a quarterly report.
 */

const HOUR_MS = 3_600_000;

export type CostBasis = 'measured' | 'estimated' | 'mixed' | 'none';

export interface RoiInput {
  sessionCount: number;
  /** Tasks: user prompts. */
  userPrompts: number;
  /** Sum of every session's active time. Idle gaps are already excluded. */
  agentActiveMs: number;
  /** Wall-clock time with at least one agent active. Overlap counted once. */
  clockActiveMs: number;
  toolCalls: number;
  errors: number;
  tokens: TokenUsage;
  /** Dollars the providers wrote down. */
  measuredCostUsd: number;
  /** Dollars this app derived from tokens and a price list. */
  estimatedCostUsd: number;
  hasMeasuredCost: boolean;
  hasEstimatedCost: boolean;
  /** Estimated saving from prompt caching over the same period. */
  cacheSavingsUsd?: number;
}

export interface RoiMetrics {
  tasks: number;
  sessions: number;
  /** Measured plus estimated. `null` when neither exists. */
  costUsd: number | null;
  costBasis: CostBasis;
  measuredCostUsd: number | null;
  estimatedCostUsd: number | null;
  costPerTaskUsd: number | null;
  costPerSessionUsd: number | null;
  /** Dollars per hour of agent work — the rate a seat of this actually costs. */
  costPerAgentHourUsd: number | null;
  costPerMillionTokensUsd: number | null;
  /** Active agent time per task. Waiting for the human is not counted. */
  agentMsPerTask: number | null;
  /** Wall-clock time per task, with parallel work collapsed. */
  clockMsPerTask: number | null;
  toolCallsPerTask: number | null;
  tokensPerTask: number | null;
  tasksPerSession: number | null;
  /** Cached input as a share of all input read. 0..1. */
  cacheHitRate: number | null;
  cacheSavingsUsd: number | null;
  /** Agent-hours delivered per wall-clock hour. 1 means strictly serial. */
  parallelism: number | null;
  errorsPerHundredTasks: number | null;
}

function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (denominator <= 0) return null;
  return numerator / denominator;
}

export function costBasisOf(hasMeasured: boolean, hasEstimated: boolean): CostBasis {
  if (hasMeasured && hasEstimated) return 'mixed';
  if (hasMeasured) return 'measured';
  if (hasEstimated) return 'estimated';
  return 'none';
}

export function computeRoi(input: RoiInput): RoiMetrics {
  const tasks = input.userPrompts;
  const hasCost = input.hasMeasuredCost || input.hasEstimatedCost;
  const costUsd = hasCost ? input.measuredCostUsd + input.estimatedCostUsd : null;

  // The normalized buckets are disjoint, so prompt tokens are simply their sum.
  const inputTokens = input.tokens.input ?? 0;
  const outputTokens = input.tokens.output ?? 0;
  const cacheRead = input.tokens.cacheRead ?? 0;
  const cacheWrite = input.tokens.cacheWrite ?? 0;
  const promptTokens = inputTokens + cacheRead + cacheWrite;
  const billableTokens = promptTokens + outputTokens;

  return {
    tasks,
    sessions: input.sessionCount,
    costUsd,
    costBasis: costBasisOf(input.hasMeasuredCost, input.hasEstimatedCost),
    measuredCostUsd: input.hasMeasuredCost ? input.measuredCostUsd : null,
    estimatedCostUsd: input.hasEstimatedCost ? input.estimatedCostUsd : null,
    costPerTaskUsd: costUsd === null ? null : ratio(costUsd, tasks),
    costPerSessionUsd: costUsd === null ? null : ratio(costUsd, input.sessionCount),
    costPerAgentHourUsd: costUsd === null ? null : ratio(costUsd, input.agentActiveMs / HOUR_MS),
    costPerMillionTokensUsd:
      costUsd === null ? null : ratio(costUsd, billableTokens / 1_000_000),
    agentMsPerTask: ratio(input.agentActiveMs, tasks),
    clockMsPerTask: ratio(input.clockActiveMs, tasks),
    toolCallsPerTask: ratio(input.toolCalls, tasks),
    tokensPerTask: ratio(billableTokens, tasks),
    tasksPerSession: ratio(tasks, input.sessionCount),
    cacheHitRate: promptTokens > 0 ? ratio(cacheRead, promptTokens) : null,
    cacheSavingsUsd: input.cacheSavingsUsd ?? null,
    parallelism: ratio(input.agentActiveMs, input.clockActiveMs),
    errorsPerHundredTasks: tasks > 0 ? (input.errors / tasks) * 100 : null,
  };
}
