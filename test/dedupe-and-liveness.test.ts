import { describe, expect, it } from 'vitest';

import { dedupeSessions } from '../src/core/dedupe.js';
import {
  ACTIVE_WINDOW_MS,
  computeLiveState,
  LIKELY_IDLE_WINDOW_MS,
  MARKER_STALE_MS,
  RECENT_WINDOW_MS,
} from '../src/core/liveness.js';
import { fakeSession, localTs } from './helpers.js';

const NOW = localTs(2024, 3, 4, 12, 0);

describe('duplicate session detection', () => {
  const window = [{ start: localTs(2024, 3, 4, 9, 0), end: localTs(2024, 3, 4, 9, 30) }];

  it('keeps one copy per (provider, sessionId)', () => {
    const a = fakeSession('dup', 'codex', window, {
      filePath: 'C:\\Users\\x\\.codex\\sessions\\a.jsonl',
    });
    const b = fakeSession('dup', 'codex', window, {
      filePath: 'C:\\mirror\\.codex\\sessions\\a.jsonl',
    });
    const { kept, duplicates } = dedupeSessions([a, b]);

    expect(kept).toHaveLength(1);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.duplicateOf).toBe(kept[0]?.filePath);
  });

  it('prefers the copy with more events', () => {
    const rich = fakeSession('dup', 'codex', window, {
      filePath: '/a.jsonl',
      counters: { events: 500, userPrompts: 2, assistantMessages: 2, toolCalls: 9, errors: 0, compactions: 0 },
    });
    const thin = fakeSession('dup', 'codex', window, {
      filePath: '/b.jsonl',
      counters: { events: 3, userPrompts: 1, assistantMessages: 1, toolCalls: 0, errors: 0, compactions: 0 },
    });

    expect(dedupeSessions([thin, rich]).kept[0]?.filePath).toBe('/a.jsonl');
    expect(dedupeSessions([rich, thin]).kept[0]?.filePath).toBe('/a.jsonl');
  });

  it('falls back to the most recently written copy when event counts tie', () => {
    const older = fakeSession('dup', 'codex', window, { filePath: '/old.jsonl', fileMtimeMs: 1000 });
    const newer = fakeSession('dup', 'codex', window, { filePath: '/new.jsonl', fileMtimeMs: 2000 });
    expect(dedupeSessions([older, newer]).kept[0]?.filePath).toBe('/new.jsonl');
  });

  it('is deterministic regardless of input order', () => {
    const a = fakeSession('dup', 'codex', window, { filePath: '/aaa.jsonl', fileMtimeMs: 5 });
    const b = fakeSession('dup', 'codex', window, { filePath: '/bb.jsonl', fileMtimeMs: 5 });
    expect(dedupeSessions([a, b]).kept[0]?.filePath).toBe(dedupeSessions([b, a]).kept[0]?.filePath);
  });

  it('never merges sessions from different providers', () => {
    const a = fakeSession('same-id', 'codex', window);
    const b = fakeSession('same-id', 'claude-code', window);
    expect(dedupeSessions([a, b]).kept).toHaveLength(2);
  });

  it('keeps a subagent separate from its parent', () => {
    const parent = fakeSession('p', 'claude-code', window, { sessionId: 'p' });
    const child = fakeSession('p#agent-a', 'claude-code', window, {
      sessionId: 'p#agent-a',
      isSubagent: true,
      parentSessionId: 'p',
    });
    expect(dedupeSessions([parent, child]).kept).toHaveLength(2);
  });

  it('sorts output by start time for a stable UI', () => {
    const later = fakeSession('b', 'codex', [
      { start: localTs(2024, 3, 4, 11, 0), end: localTs(2024, 3, 4, 11, 5) },
    ]);
    const earlier = fakeSession('a', 'codex', window);
    expect(dedupeSessions([later, earlier]).kept.map((s) => s.key)).toEqual(['a', 'b']);
  });
});

describe('liveness grading', () => {
  const base = { fileMtimeMs: 0, now: NOW };

  it('grades purely by recency when the provider publishes no marker', () => {
    expect(computeLiveState({ ...base, lastEventTs: NOW - 10_000 }).status).toBe('active');
    expect(computeLiveState({ ...base, lastEventTs: NOW - RECENT_WINDOW_MS + 1000 }).status).toBe(
      'recently_active',
    );
    expect(computeLiveState({ ...base, lastEventTs: NOW - LIKELY_IDLE_WINDOW_MS + 1000 }).status).toBe(
      'likely_idle',
    );
    expect(computeLiveState({ ...base, lastEventTs: NOW - 4 * 3_600_000 }).status).toBe('ended');
  });

  it('never claims high confidence from recency alone', () => {
    const state = computeLiveState({ ...base, lastEventTs: NOW - 5_000 });
    expect(state.confidence).toBe('medium');
    expect(state.evidence.join(' ')).toContain('no runtime marker');
  });

  it('upgrades to high confidence when a fresh marker says the session is busy', () => {
    const state = computeLiveState({
      ...base,
      lastEventTs: NOW - 20 * 60_000,
      marker: {
        sessionId: 's',
        state: 'busy',
        updatedAtMs: NOW - 2_000,
        pid: 1234,
        pidAlive: true,
        source: 'test',
      },
    });
    expect(state.status).toBe('active');
    expect(state.confidence).toBe('high');
  });

  it('treats an alive-but-idle session as idle, never as ended', () => {
    const state = computeLiveState({
      ...base,
      lastEventTs: NOW - 3 * 3_600_000,
      marker: {
        sessionId: 's',
        state: 'idle',
        updatedAtMs: NOW - 5_000,
        pid: 1234,
        pidAlive: true,
        source: 'test',
      },
    });
    expect(state.status).toBe('recently_active');
    expect(state.confidence).toBe('high');
  });

  it('declares the session ended, with high confidence, when its pid is gone', () => {
    const state = computeLiveState({
      ...base,
      lastEventTs: NOW - 1_000,
      marker: {
        sessionId: 's',
        state: 'busy',
        updatedAtMs: NOW - 1_000,
        pid: 999999,
        pidAlive: false,
        source: 'test',
      },
    });
    expect(state.status).toBe('ended');
    expect(state.confidence).toBe('high');
    expect(state.evidence.join(' ')).toContain('is gone');
  });

  it('downgrades a stale marker instead of trusting its status', () => {
    const state = computeLiveState({
      ...base,
      lastEventTs: NOW - 20 * 60_000,
      marker: {
        sessionId: 's',
        state: 'busy',
        updatedAtMs: NOW - MARKER_STALE_MS - 60_000,
        pid: 1234,
        pidAlive: true,
        source: 'test',
      },
    });
    expect(state.status).not.toBe('active');
    expect(state.confidence).toBe('medium');
    expect(state.evidence.join(' ')).toContain('stale');
  });

  it('uses file mtime when it is newer than the last parsed event', () => {
    const state = computeLiveState({
      lastEventTs: NOW - 2 * 3_600_000,
      fileMtimeMs: NOW - ACTIVE_WINDOW_MS / 2,
      now: NOW,
    });
    expect(state.status).toBe('active');
    expect(state.evidence.join(' ')).toContain('log file modified');
  });

  it('always returns at least one piece of evidence', () => {
    const state = computeLiveState({ lastEventTs: 0, fileMtimeMs: 0, now: NOW });
    expect(state.evidence.length).toBeGreaterThan(0);
  });
});
