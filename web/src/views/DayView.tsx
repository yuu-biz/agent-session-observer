import type { DayResponse } from '@api/api';
import type { ProviderId } from '@core/types';
import { useEffect, useState } from 'react';

import { SessionTable } from '../components/SessionTable';
import { Timeline } from '../components/Timeline';
import { Panel, Stat, Tiles } from '../components/Tiles';
import { api } from '../lib/api';
import { fmtClock, fmtCompact, fmtCost, fmtDuration, PROVIDER_LABEL, shiftDay, todayKey } from '../lib/format';

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
        title="Day"
        actions={
          <div className="controls">
            <button className="btn" onClick={() => onChangeDay(shiftDay(dayKey, -1))}>
              ← prev
            </button>
            <input
              type="date"
              value={dayKey}
              max={todayKey()}
              onChange={(e) => e.target.value && onChangeDay(e.target.value)}
            />
            <button className="btn" onClick={() => onChangeDay(shiftDay(dayKey, 1))} disabled={dayKey >= todayKey()}>
              next →
            </button>
            <button className="btn" onClick={() => onChangeDay(todayKey())}>
              today
            </button>
          </div>
        }
        flush
      >
        <Tiles>
          <Stat
            label="Clock time active"
            kind="estimate"
            value={fmtDuration(summary?.clockActiveMs ?? 0)}
            sub="≥1 agent running"
          />
          <Stat
            label="Agent time (sum)"
            kind="estimate"
            value={fmtDuration(summary?.agentActiveMs ?? 0)}
            sub={
              summary && summary.clockActiveMs > 0
                ? `${(summary.agentActiveMs / summary.clockActiveMs).toFixed(2)}× parallel`
                : '—'
            }
          />
          <Stat
            label="Wall span covered"
            value={fmtDuration(summary?.wallSpanMs ?? 0)}
            sub={
              summary?.firstActivityTs
                ? `${fmtClock(summary.firstActivityTs)} – ${fmtClock(summary.lastActivityTs)}`
                : '—'
            }
          />
          <Stat label="Sessions" value={String(summary?.sessionCount ?? 0)} />
          <Stat
            label="Peak concurrency"
            value={String(summary?.peakConcurrency ?? 0)}
            sub={summary ? `avg ${summary.avgConcurrency.toFixed(2)} while active` : '—'}
          />
          <Stat label="Tool calls" value={fmtCompact(summary?.toolCalls ?? 0)} sub={`${summary?.userPrompts ?? 0} prompts`} />
          <Stat
            label="Cost"
            kind="measured"
            value={summary?.hasCostData ? fmtCost(summary.costUsd) : 'n/a'}
          />
        </Tiles>
      </Panel>

      {error && <div className="note warn">Failed to load day: {error}</div>}

      <Panel
        title="Timeline"
        actions={
          <div className="legend">
            <span>
              <i style={{ background: 'var(--border)' }} />
              wall span
            </span>
            <span>
              <i style={{ background: 'var(--codex)' }} />
              Codex active
            </span>
            <span>
              <i style={{ background: 'var(--claude)' }} />
              Claude Code active
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
          <div className="empty">No sessions on this day.</div>
        )}
      </Panel>

      {summary && summary.msAtConcurrency.length > 0 && (
        <Panel title="Time spent at each concurrency level">
          <table className="grid" style={{ maxWidth: 480 }}>
            <thead>
              <tr>
                <th className="num">Sessions active</th>
                <th className="num">Clock time</th>
                <th className="num">Share of active time</th>
              </tr>
            </thead>
            <tbody>
              {summary.msAtConcurrency.map((row) => (
                <tr key={row.level}>
                  <td className="num">{row.level}</td>
                  <td className="num">{fmtDuration(row.ms)}</td>
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
        <Panel title="By provider">
          <table className="grid" style={{ maxWidth: 800 }}>
            <thead>
              <tr>
                <th>Provider</th>
                <th className="num">Sessions</th>
                <th className="num">Agent time</th>
                <th className="num">Clock time</th>
                <th className="num">Prompts</th>
                <th className="num">Tool calls</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {summary.byProvider.map((p) => (
                <tr key={p.provider}>
                  <td>
                    <span className={`badge ${p.provider}`}>{PROVIDER_LABEL[p.provider]}</span>
                  </td>
                  <td className="num">{p.sessionCount}</td>
                  <td className="num">{fmtDuration(p.agentActiveMs)}</td>
                  <td className="num dim">{fmtDuration(p.clockActiveMs)}</td>
                  <td className="num">{p.userPrompts}</td>
                  <td className="num">{p.toolCalls}</td>
                  <td className="num dim">{p.costUsd == null ? 'n/a' : fmtCost(p.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      <Panel title={`Sessions (${data?.sessions.length ?? 0})`} flush>
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
