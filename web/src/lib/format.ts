import type { ProviderId, TokenUsage } from '@core/types';

/** Presentation helpers. Kept in the web layer: formatting is not domain logic. */

export function fmtDuration(ms: number | undefined | null): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '0m';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

export function fmtDurationPrecise(ms: number | undefined | null): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return fmtDuration(ms);
}

export function fmtClock(ts: number | null | undefined): string {
  if (ts == null) return '—';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function fmtClockSec(ts: number): string {
  const d = new Date(ts);
  return `${fmtClock(ts)}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  return `${d.toLocaleDateString()} ${fmtClockSec(ts)}`;
}

export function fmtNumber(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString();
}

export function fmtCompact(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

export function fmtCost(usd: number | undefined | null): string {
  if (usd == null || !Number.isFinite(usd)) return 'n/a';
  if (usd === 0) return '$0.00';
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export function tokenTotal(t: TokenUsage | undefined): number {
  if (!t) return 0;
  return (t.input ?? 0) + (t.output ?? 0);
}

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
};

export function todayKey(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function shiftDay(dayKey: string, delta: number): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const date = new Date(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + delta, 12);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

export function weekdayShort(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).toLocaleDateString(undefined, {
    weekday: 'short',
  });
}

export const LIVE_LABEL: Record<string, string> = {
  active: 'Active',
  recently_active: 'Recently active',
  likely_idle: 'Likely idle',
  ended: 'Ended',
};

/** Shortens a long absolute path for display without losing the tail. */
export function shortPath(p: string | undefined, max = 46): string {
  if (!p) return '—';
  if (p.length <= max) return p;
  return `…${p.slice(p.length - max + 1)}`;
}
