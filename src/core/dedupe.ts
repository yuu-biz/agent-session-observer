import type { SessionSummary } from './types.js';

/**
 * The same session can legitimately be discovered more than once:
 *
 *  - a Windows home and a WSL distro that bind-mount the same directory,
 *  - an archived copy alongside the live rollout file,
 *  - a manually added root that overlaps a default one.
 *
 * Sessions are identified by `(provider, sessionId)`. When duplicates appear we
 * keep the richest copy (most events, then most recently written, then the
 * shortest path as a tiebreaker so results are stable) and mark the rest.
 */

export interface DedupeResult {
  kept: SessionSummary[];
  duplicates: SessionSummary[];
}

function betterThan(a: SessionSummary, b: SessionSummary): boolean {
  if (a.counters.events !== b.counters.events) return a.counters.events > b.counters.events;
  if (a.fileMtimeMs !== b.fileMtimeMs) return a.fileMtimeMs > b.fileMtimeMs;
  if (a.fileSize !== b.fileSize) return a.fileSize > b.fileSize;
  if (a.filePath.length !== b.filePath.length) return a.filePath.length < b.filePath.length;
  return a.filePath < b.filePath;
}

export function dedupeSessions(sessions: readonly SessionSummary[]): DedupeResult {
  const best = new Map<string, SessionSummary>();
  const all = new Map<string, SessionSummary[]>();

  for (const s of sessions) {
    const id = `${s.provider}:${s.sessionId}`;
    const group = all.get(id);
    if (group) group.push(s);
    else all.set(id, [s]);

    const cur = best.get(id);
    if (!cur || betterThan(s, cur)) best.set(id, s);
  }

  const kept: SessionSummary[] = [];
  const duplicates: SessionSummary[] = [];

  for (const [id, group] of all) {
    const winner = best.get(id) as SessionSummary;
    kept.push(winner);
    for (const s of group) {
      if (s === winner) continue;
      duplicates.push({ ...s, duplicateOf: winner.filePath });
    }
  }

  kept.sort((a, b) => a.startedAt - b.startedAt || a.key.localeCompare(b.key));
  return { kept, duplicates };
}
