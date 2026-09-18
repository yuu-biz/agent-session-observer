import type { DayResponse } from '@api/api';
import type { ProviderId } from '@core/types';
import { useEffect, useState } from 'react';

import { SessionTable } from '../components/SessionTable';
import { Timeline } from '../components/Timeline';
import { Panel, Stat, Tiles } from '../components/Tiles';
import { api } from '../lib/api';
import {
  fmtClock,
  fmtCompact,
  fmtCost,
  PROVIDER_LABEL,
  shiftDay,
  todayKey,
  useFormat,
} from '../lib/format';
import { useI18n } from '../lib/i18n';

export function DayView({
  dayKey,
  provider,
  refreshToken,
  onChangeDay,
  onPickSession,
}: {
  dayKey: string;
  provider: ProviderId | 'all';
  refreshToken: number;
  onChangeDay: (day: string) => void;
  onPickSession: (key: string) => void;
}): React.ReactElement {
  const { t } = useI18n();
  const f = useFormat();
  const [data, setData] = useState<DayResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .day(dayKey, provider)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [dayKey, provider, refreshToken]);

  const summary = data?.summary ?? null;

  return (
    <>
      <Panel
        title={t('day.title')}
        actions={
          <div className="controls">
            <button className="btn" onClick={() => onChangeDay(shiftDay(dayKey, -1))}>
              {t('day.prev')}
            </button>
            <input
              type="date"
              value={dayKey}
              max={todayKey()}
              onChange={(e) => e.target.value && onChangeDay(e.target.value)}
            />
            <button className="btn" onClick={() => onChangeDay(shiftDay(dayKey, 1))} disabled={dayKey >= todayKey()}>
              {t('day.next')}
            </button>
            <button className="btn" onClick={() => onChangeDay(todayKey())}>
              {t('day.today')}
            </button>
          </div>
        }
        flush
      >
        <Tiles>
          <Stat
            label={t('day.clockActive')}
            kind="estimate"
            value={f.duration(summary?.clockActiveMs ?? 0)}
            sub={t('day.clockActiveSub')}
          />
          <Stat
            label={t('day.agentTime')}
            kind="estimate"
            value={f.duration(summary?.agentActiveMs ?? 0)}
            sub={
              summary && summary.clockActiveMs > 0
                ? t('overview.parallel', {
                    x: (summary.agentActiveMs / summary.clockActiveMs).toFixed(2),
                  })
                : '—'
            }
          />
          <Stat
            label={t('day.wallSpan')}
            value={f.duration(summary?.wallSpanMs ?? 0)}
            sub={
              summary?.firstActivityTs
                ? `${fmtClock(summary.firstActivityTs)} – ${fmtClock(summary.lastActivityTs)}`
                : '—'
            }
          />
          <Stat label={t('day.sessions')} value={String(summary?.sessionCount ?? 0)} />
          <Stat
            label={t('day.peak')}
            value={String(summary?.peakConcurrency ?? 0)}
            sub={summary ? t('day.avgWhileActive', { avg: summary.avgConcurrency.toFixed(2) }) : '—'}
          />
          <Stat label={t('day.colToolCalls')} value={fmtCompact(summary?.toolCalls ?? 0)} sub={t('overview.prompts', { n: summary?.userPrompts ?? 0 })} />
          <Stat
            label={t('day.colCost')}
            kind="measured"
            value={summary?.hasCostData ? fmtCost(summary.costUsd) : t('common.na')}
          />
        </Tiles>
      </Panel>

      {error && <div className="note warn">{t('day.loadFailed', { error })}</div>}

      <Panel
        title={t('day.timeline')}
        actions={
          <div className="legend">
            <span>
              <i style={{ background: 'var(--border)' }} />
              {t('day.legendWall')}
            </span>
            <span>
              <i style={{ background: 'var(--codex)' }} />
              {t('day.legendCodex')}
            </span>
            <span>
              <i style={{ background: 'var(--claude)' }} />
              {t('day.legendClaude')}
            </span>
          </div>
        }
      >
        {data && data.sessions.length > 0 ? (
          <Timeline
            dayStart={data.dayStart}
            dayEnd={data.dayEnd}
            sessions={data.sessions}
            concurrencySteps={data.concurrencySteps}
            selectedKey={selected}
            onSelect={(key) => {
              setSelected(key);
              onPickSession(key);
            }}
            now={Date.now()}
          />
        ) : (
          <div className="empty">{t('day.noSessions')}</div>
        )}
      </Panel>

      {summary && summary.msAtConcurrency.length > 0 && (
        <Panel title={t('day.concurrencyTable')}>
          <table className="grid" style={{ maxWidth: 480 }}>
            <thead>
              <tr>
                <th className="num">{t('day.colSessionsActive')}</th>
                <th className="num">{t('day.colClockTime')}</th>
                <th className="num">{t('day.colShare')}</th>
              </tr>
            </thead>
            <tbody>
              {summary.msAtConcurrency.map((row) => (
                <tr key={row.level}>
                  <td className="num">{row.level}</td>
                  <td className="num">{f.duration(row.ms)}</td>
                  <td className="num dim">
                    {summary.clockActiveMs > 0
                      ? `${((row.ms / summary.clockActiveMs) * 100).toFixed(0)}%`
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      {summary && summary.byProvider.length > 0 && (
        <Panel title={t('day.byProvider')}>
          <table className="grid" style={{ maxWidth: 800 }}>
            <thead>
              <tr>
                <th>{t('table.provider')}</th>
                <th className="num">{t('day.sessions')}</th>
                <th className="num">{t('day.colAgentTime')}</th>
                <th className="num">{t('day.colClockTime')}</th>
                <th className="num">{t('day.colPrompts')}</th>
                <th className="num">{t('day.colToolCalls')}</th>
                <th className="num">{t('day.colCost')}</th>
              </tr>
            </thead>
            <tbody>
              {summary.byProvider.map((p) => (
                <tr key={p.provider}>
                  <td>
                    <span className={`badge ${p.provider}`}>{PROVIDER_LABEL[p.provider]}</span>
                  </td>
                  <td className="num">{p.sessionCount}</td>
                  <td className="num">{f.duration(p.agentActiveMs)}</td>
                  <td className="num dim">{f.duration(p.clockActiveMs)}</td>
                  <td className="num">{p.userPrompts}</td>
                  <td className="num">{p.toolCalls}</td>
                  <td className="num dim">{p.costUsd == null ? t('common.na') : fmtCost(p.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      <Panel title={t('day.sessionsTitle', { n: data?.sessions.length ?? 0 })} flush>
        <SessionTable
          sessions={data?.sessions ?? []}
          selectedKey={selected}
          onSelect={(key) => {
            setSelected(key);
            onPickSession(key);
          }}
        />
      </Panel>
    </>
  );
}
