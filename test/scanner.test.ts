import { mkdtemp, rm, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, normalizeConfig } from '../src/core/config.js';
import { buildDay, buildOverview } from '../src/server/api.js';
import { SessionScanner } from '../src/indexer/scanner.js';
import { CLAUDE_ROOT, CODEX_ROOT } from './helpers.js';

/**
 * End-to-end over the committed fixtures: discovery -> parse -> analysis.
 * `AGENT_SESSION_OBSERVER_HOME` is redirected so the test never touches the
 * developer's real cache, and `extraRoots` is used so the test never depends on
 * whatever Codex or Claude Code happen to be installed on the machine.
 */

let cacheHome: string;
/** An empty home, so discovery cannot find the developer's real installs. */
let emptyHome: string;
const original = process.env.AGENT_SESSION_OBSERVER_HOME;

beforeAll(async () => {
  cacheHome = await mkdtemp(path.join(os.tmpdir(), 'aso-cache-'));
  emptyHome = await mkdtemp(path.join(os.tmpdir(), 'aso-home-'));
  process.env.AGENT_SESSION_OBSERVER_HOME = cacheHome;
});

afterAll(async () => {
  if (original === undefined) delete process.env.AGENT_SESSION_OBSERVER_HOME;
  else process.env.AGENT_SESSION_OBSERVER_HOME = original;
  await rm(cacheHome, { recursive: true, force: true });
  await rm(emptyHome, { recursive: true, force: true });
});

function testConfig(overrides: Partial<typeof DEFAULT_CONFIG> = {}): typeof DEFAULT_CONFIG {
  return {
    ...DEFAULT_CONFIG,
    // The fixtures carry 2024 timestamps, but the window filters on mtime.
    lookbackDays: 3650,
    wslMode: 'off',
    extraRoots: [
      { provider: 'codex', path: CODEX_ROOT },
      { provider: 'claude-code', path: CLAUDE_ROOT },
    ],
    ...overrides,
  };
}

function makeScanner(overrides: Partial<typeof DEFAULT_CONFIG> = {}): SessionScanner {
  return new SessionScanner({
    config: testConfig(overrides),
    discovery: { homeDir: emptyHome, platform: 'linux', env: {} },
  });
}

describe('scanner end to end', () => {
  it('discovers, parses and normalizes every fixture session', async () => {
    const scanner = makeScanner();
    const result = await scanner.scan();

    expect(result.filesScanned).toBe(5); // 3 codex + 1 claude + 1 claude subagent
    const keys = result.sessions.map((s) => s.key).sort();
    expect(keys).toEqual([
      'claude-code:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
      'claude-code:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa#agent-demo',
      'codex:11111111-1111-4111-8111-111111111111',
      'codex:22222222-2222-4222-8222-222222222222',
      'codex:33333333-3333-4333-8333-333333333333',
    ]);
    expect(result.duplicates).toHaveLength(0);
  });

  it('links subagents to their parent session', async () => {
    const scanner = makeScanner();
    const { sessions } = await scanner.scan();

    const sub = sessions.find((s) => s.isSubagent && s.provider === 'claude-code');
    expect(sub?.parentSessionKey).toBe('claude-code:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');
    expect(sessions.some((s) => s.key === sub?.parentSessionKey)).toBe(true);
  });

  it('separates measured provider timings from its own estimates', async () => {
    const scanner = makeScanner();
    const { sessions } = await scanner.scan();

    const claude = sessions.find((s) => s.key === 'claude-code:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');
    expect(claude?.measured.apiMs).toBe(41_000);
    expect(claude?.costUsd).toBeCloseTo(1.2345, 6);
    // The estimate is derived independently and must not equal the measurement.
    expect(claude?.activity.activeMs).not.toBe(claude?.measured.apiMs);

    const codex = sessions.find((s) => s.key === 'codex:11111111-1111-4111-8111-111111111111');
    expect(codex?.costUsd).toBeUndefined(); // Codex never reports cost
    expect(codex?.measured.apiMs).toBe(51_000);
  });

  it('computes a plausible wall span, active estimate and idle split', async () => {
    const scanner = makeScanner();
    const { sessions } = await scanner.scan();
    const codex = sessions.find((s) => s.key === 'codex:11111111-1111-4111-8111-111111111111');

    // Two bursts separated by a ~40 minute gap.
    expect(codex?.activity.segments).toHaveLength(2);
    expect(codex?.activity.idleGaps).toHaveLength(1);
    expect(codex?.wallSpanMs).toBe((codex?.activity.activeMs ?? 0) + (codex?.activity.idleMs ?? 0));
  });

  it('serves a warm scan from cache without re-reading unchanged files', async () => {
    const scanner = makeScanner();
    await scanner.scan();
    const warm = await scanner.scan();
    expect(warm.filesParsed).toBe(0);
    expect(warm.sessions).toHaveLength(5);
  });

  it('re-derives activity when the idle threshold changes, with no re-parse', async () => {
    const scanner = makeScanner();
    const before = await scanner.scan();
    const codexBefore = before.sessions.find((s) => s.key === 'codex:11111111-1111-4111-8111-111111111111');
    expect(codexBefore?.activity.segments).toHaveLength(2);

    scanner.updateConfig(testConfig({ idleThresholdMs: 60 * 60_000 }));
    const after = await scanner.scan();
    const codexAfter = after.sessions.find((s) => s.key === 'codex:11111111-1111-4111-8111-111111111111');

    expect(after.filesParsed).toBe(0); // nothing was re-read
    expect(codexAfter?.activity.segments).toHaveLength(1); // the gap is now "active"
    expect(codexAfter?.activity.activeMs).toBeGreaterThan(codexBefore?.activity.activeMs ?? 0);
  });

  it('skips files older than the lookback window without opening them', async () => {
    const stale = path.join(
      CODEX_ROOT,
      'sessions/2024/03/04/rollout-2024-03-04T10-00-00-22222222-2222-4222-8222-222222222222.jsonl',
    );
    const old = new Date(Date.now() - 400 * 24 * 3_600_000);
    await utimes(stale, old, old);
    try {
      const result = await makeScanner({ lookbackDays: 30 }).scan();
      expect(result.filesScanned).toBe(4);
      expect(result.sessions.some((s) => s.sessionId.startsWith('22222222'))).toBe(false);

      const wide = await makeScanner({ lookbackDays: 3650 }).scan();
      expect(wide.filesScanned).toBe(5);
    } finally {
      const now = new Date();
      await utimes(stale, now, now);
    }
  });

  it('loads full session detail on demand', async () => {
    const scanner = makeScanner();
    await scanner.scan();
    const detail = await scanner.loadDetail('codex:11111111-1111-4111-8111-111111111111');

    expect(detail).not.toBeNull();
    expect(detail?.events.length).toBeGreaterThan(5);
    expect(detail?.eventsTruncated).toBe(false);
    // The session_meta event precedes the first prompt, so phase 0 is setup
    // and each user prompt opens a phase of its own after it.
    expect(detail?.phases.map((p) => p.title)).toEqual([
      'session setup',
      'Add a health check endpoint.',
      'Now add docs.',
    ]);
  });

  it('returns null for an unknown session key', async () => {
    const scanner = makeScanner();
    await scanner.scan();
    expect(await scanner.loadDetail('codex:does-not-exist')).toBeNull();
  });
});

describe('api shaping', () => {
  it('builds a day response with lanes and a concurrency step function', async () => {
    const scanner = makeScanner();
    await scanner.scan();
    const day = buildDay(scanner, { dayKey: '2024-03-04', provider: 'all' });

    expect(day.sessions.length).toBeGreaterThan(0);
    expect(day.sessions.every((s) => s.lane >= 0)).toBe(true);
    expect(day.concurrencySteps.length).toBeGreaterThan(0);
    // Every session's day segments must lie inside the day window.
    for (const s of day.sessions) {
      for (const seg of s.daySegments) {
        expect(seg.start).toBeGreaterThanOrEqual(day.dayStart);
        expect(seg.end).toBeLessThanOrEqual(day.dayEnd);
      }
    }
  });

  it('filters a day by provider', async () => {
    const scanner = makeScanner();
    await scanner.scan();
    const codexOnly = buildDay(scanner, { dayKey: '2024-03-04', provider: 'codex' });
    expect(codexOnly.sessions.every((s) => s.provider === 'codex')).toBe(true);
  });

  it('fills days with no activity as zeroes rather than omitting them', async () => {
    const scanner = makeScanner();
    await scanner.scan();
    const overview = buildOverview(scanner, { days: 7, provider: 'all', now: Date.now() });
    expect(overview.days).toHaveLength(7);
    expect(overview.days.every((d) => typeof d.clockActiveMs === 'number')).toBe(true);
  });
});

describe('config validation', () => {
  it('clamps and sanitises untrusted config JSON', () => {
    const config = normalizeConfig({
      idleThresholdMs: -1,
      wslMode: 'sudo-rm-rf',
      lookbackDays: 1e9,
      refreshIntervalMs: 1,
      port: 99999,
      extraRoots: [
        { provider: 'codex', path: '  /valid  ' },
        { provider: 'evil', path: '/x' },
        { provider: 'codex' },
        'nope',
      ],
    });

    expect(config.idleThresholdMs).toBe(10_000);
    expect(config.wslMode).toBe('running');
    expect(config.lookbackDays).toBe(3650);
    expect(config.refreshIntervalMs).toBe(1000);
    expect(config.port).toBe(DEFAULT_CONFIG.port);
    expect(config.extraRoots).toEqual([{ provider: 'codex', path: '/valid' }]);
  });

  it('falls back to defaults for garbage input', () => {
    expect(normalizeConfig(null)).toEqual(DEFAULT_CONFIG);
    expect(normalizeConfig('nope')).toEqual(DEFAULT_CONFIG);
    expect(normalizeConfig(42)).toEqual(DEFAULT_CONFIG);
  });
});
