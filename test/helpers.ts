import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DiscoveryRoot, Interval, NormalizedEvent, ProviderId, SessionSummary } from '../src/core/types.js';

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

export const CODEX_ROOT = path.join(FIXTURES, 'codex');
export const CLAUDE_ROOT = path.join(FIXTURES, 'claude-code');

export function fakeRoot(provider: ProviderId, rootPath: string): DiscoveryRoot {
  return {
    id: `${provider}:local:${rootPath}`,
    provider,
    host: { kind: 'local', label: 'local' },
    path: rootPath,
    origin: 'default',
  };
}

export function ev(iso: string, kind: NormalizedEvent['kind'] = 'system'): NormalizedEvent {
  return { ts: Date.parse(iso), kind };
}

/** Minimal session summary for analysis tests; only the fields used are real. */
export function fakeSession(
  key: string,
  provider: ProviderId,
  segments: Interval[],
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  const start = segments[0]?.start ?? 0;
  const end = segments[segments.length - 1]?.end ?? 0;
  return {
    key,
    provider,
    sessionId: key,
    host: { kind: 'local', label: 'local' },
    rootId: 'root',
    filePath: `/tmp/${key}.jsonl`,
    fileSize: 100,
    fileMtimeMs: end,
    models: [],
    startedAt: start,
    endedAt: end,
    wallSpanMs: Math.max(0, end - start),
    activity: {
      idleThresholdMs: 300_000,
      segments,
      activeMs: segments.reduce((sum, s) => sum + (s.end - s.start), 0),
      idleMs: 0,
      idleGaps: [],
    },
    measured: {},
    counters: {
      events: segments.length * 2,
      userPrompts: 1,
      assistantMessages: 1,
      toolCalls: 2,
      errors: 0,
      compactions: 0,
    },
    tokens: {},
    live: { status: 'ended', confidence: 'low', evidence: [] },
    ...overrides,
  };
}

/** `2024-03-04T09:00:00Z` style helper that keeps tests readable. */
export function t(iso: string): number {
  return Date.parse(iso);
}

/** Builds a local-time timestamp, so day-boundary tests are TZ independent. */
export function localTs(
  y: number,
  m: number,
  d: number,
  h = 0,
  min = 0,
  s = 0,
): number {
  return new Date(y, m - 1, d, h, min, s, 0).getTime();
}
