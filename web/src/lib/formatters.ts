import type { Lang } from './messages.js';

/**
 * Pure presentation helpers.
 *
 * Free of React, of the DOM, and of any project import beyond the message
 * table, so the Node test suite can import this module directly. The
 * locale-bound hook that wraps these lives in `format.ts`.
 */

/** Structural, so this module needs nothing from the server's type tree. */
type ProviderId = 'codex' | 'claude-code';
interface TokenCounts {
  input?: number;
  output?: number;
  cacheRead?: number;
}

interface DurationUnits {
  h: string;
  m: string;
  s: string;
  sep: string;
}

const DURATION_UNITS: Record<Lang, DurationUnits> = {
  en: { h: 'h', m: 'm', s: 's', sep: ' ' },
  ja: { h: '時間', m: '分', s: '秒', sep: '' },
};

function units(lang: Lang): DurationUnits {
  return DURATION_UNITS[lang] ?? DURATION_UNITS.en;
}

export function fmtDuration(ms: number | undefined | null, lang: Lang = 'en'): string {
  const u = units(lang);
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return `0${u.m}`;
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h}${u.h}${u.sep}${m}${u.m}` : `${h}${u.h}`;
  if (m > 0) return `${m}${u.m}`;
  return `${s}${u.s}`;
}

export function fmtDurationPrecise(ms: number | undefined | null, lang: Lang = 'en'): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}${units(lang).s}`;
  return fmtDuration(ms, lang);
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

export function fmtDateTime(ts: number, locale = 'en-US'): string {
  return `${new Date(ts).toLocaleDateString(locale)} ${fmtClockSec(ts)}`;
}

export function fmtNumber(n: number | undefined | null, locale = 'en-US'): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString(locale);
}

export function fmtCompact(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/**
 * Cost stays in USD whatever the interface language: it is the unit the
 * provider recorded, and converting it would invent precision we do not have.
 */
export function fmtCost(usd: number | undefined | null): string {
  if (usd == null || !Number.isFinite(usd)) return 'n/a';
  if (usd === 0) return '$0.00';
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export function tokenTotal(t: TokenCounts | undefined): number {
  if (!t) return 0;
  return (t.input ?? 0) + (t.output ?? 0);
}

/** Product names, never translated. */
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

export function weekdayShort(dayKey: string, locale = 'en-US'): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).toLocaleDateString(locale, { weekday: 'short' });
}

/** Shortens a long absolute path for display without losing the tail. */
export function shortPath(p: string | undefined, max = 46): string {
  if (!p) return '—';
  if (p.length <= max) return p;
  return `…${p.slice(p.length - max + 1)}`;
}
