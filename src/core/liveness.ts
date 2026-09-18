import type { LiveMarker, LiveState, LiveStatus } from './types.js';

/**
 * Liveness
 * ========
 *
 * A log file cannot prove that a process is alive. The best it can do is show
 * that something wrote to it recently. So every status carries a confidence
 * level and a list of the evidence it was derived from, and the UI renders that
 * evidence rather than asserting "running".
 *
 * Strongest evidence available today:
 *   Claude Code writes `~/.claude/sessions/<pid>.json` for each live session,
 *   with `status: busy | idle` and a heartbeat `updatedAt`. When the pid is
 *   still alive we can say `active` with high confidence.
 *
 *   Codex has no equivalent per-session runtime marker, so its sessions are
 *   always graded from event recency alone (`low` confidence).
 */

export const ACTIVE_WINDOW_MS = 90_000;
export const RECENT_WINDOW_MS = 5 * 60_000;
export const LIKELY_IDLE_WINDOW_MS = 30 * 60_000;
/** A heartbeat older than this means the marker file is stale. */
export const MARKER_STALE_MS = 10 * 60_000;

export interface LivenessInput {
  /** Timestamp of the last event parsed from the log. */
  lastEventTs: number;
  /** mtime of the backing log file. */
  fileMtimeMs: number;
  /** Runtime marker for this session, if the provider publishes one. */
  marker?: LiveMarker | undefined;
  /** Injected for deterministic tests. */
  now: number;
}

function rank(status: LiveStatus): number {
  switch (status) {
    case 'active':
      return 3;
    case 'recently_active':
      return 2;
    case 'likely_idle':
      return 1;
    default:
      return 0;
  }
}

function fromRecency(ageMs: number): LiveStatus {
  if (ageMs <= ACTIVE_WINDOW_MS) return 'active';
  if (ageMs <= RECENT_WINDOW_MS) return 'recently_active';
  if (ageMs <= LIKELY_IDLE_WINDOW_MS) return 'likely_idle';
  return 'ended';
}

function humanAge(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}

export function computeLiveState(input: LivenessInput): LiveState {
  const { lastEventTs, fileMtimeMs, marker, now } = input;
  const evidence: string[] = [];

  const lastTouch = Math.max(lastEventTs, fileMtimeMs);
  const age = Math.max(0, now - lastTouch);
  let status = fromRecency(age);
  let confidence: LiveState['confidence'] = 'low';

  if (lastEventTs > 0) {
    evidence.push(`last log event ${humanAge(Math.max(0, now - lastEventTs))}`);
  }
  if (fileMtimeMs > lastEventTs) {
    evidence.push(`log file modified ${humanAge(Math.max(0, now - fileMtimeMs))}`);
  }

  if (marker) {
    const markerAge = marker.updatedAtMs ? Math.max(0, now - marker.updatedAtMs) : Infinity;
    const stale = markerAge > MARKER_STALE_MS;
    const alive = marker.pidAlive !== false;

    if (!alive) {
      evidence.push(`runtime marker found (${marker.source}) but pid ${marker.pid ?? '?'} is gone`);
      // A dead pid is strong evidence the session is over.
      return { status: 'ended', confidence: 'high', evidence };
    }

    if (stale) {
      evidence.push(`runtime marker (${marker.source}) heartbeat is stale (${humanAge(markerAge)})`);
      confidence = 'medium';
    } else {
      const state = marker.state ?? 'unknown';
      evidence.push(
        `runtime marker (${marker.source}) reports "${state}", heartbeat ${humanAge(markerAge)}`,
      );
      confidence = 'high';
      const markerStatus: LiveStatus = state === 'busy' ? 'active' : 'recently_active';
      if (rank(markerStatus) > rank(status)) status = markerStatus;
      // An idle-but-alive CLI session is never "ended".
      if (status === 'ended') status = 'likely_idle';
    }
  } else if (status === 'active' || status === 'recently_active') {
    // Recency alone can't distinguish "running" from "just finished".
    confidence = 'medium';
    evidence.push('no runtime marker available for this provider; status inferred from log recency');
  }

  if (evidence.length === 0) evidence.push('no activity evidence');
  return { status, confidence, evidence };
}
