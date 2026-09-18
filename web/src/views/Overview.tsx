import type { OverviewResponse } from '@api/api';
import type { ProviderId } from '@core/types';
import { useEffect, useState } from 'react';

import { DailyBars } from '../components/DailyBars';
import { Panel, Stat, Tiles } from '../components/Tiles';
import { api } from '../lib/api';
import {
  fmtCost,
  fmtCompact,
  fmtDuration,
  fmtClock,
  LIVE_LABEL,
  PROVIDER_LABEL,
  tokenTotal,
} from '../lib/format';

export function Overview({
  days,
  provider,
  refreshToken,
  onPickDay,
  onPickSession,
}: {
  days: number;
  provider: ProviderId | 'all';
  refreshToken: number;
  onPickDay: (dayKey: string) => void;
  onPickSession: (key: string) => void;
}): React.ReactElement {
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .overview(days, provider)
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
  }, [days, provider, refreshToken]);

  if (error) return <div className="note warn">Failed to load overview: {error}</div>;
  if (!data) return <div className="empty">Loading…</div>;

  const today = data.today;
  const totals = data.totals;

  return (
    <>
      <Panel title={`Today · ${data.days[data.days.length - 1]?.dayKey ?? ''}`} flush>
        <Tiles>
          <Stat
            label="Clock time with an agent running"
            kind="estimate"
            value={fmtDuration(today?.clockActiveMs ?? 0)}
            sub="union of all active segments"
            title="Wall-clock time during which at least one session was active. Overlapping sessions are counted once."
          />
          <Stat
            label="Summed agent time"
            kind="estimate"
            value={fmtDuration(today?.agentActiveMs ?? 0)}
            sub={
              today && today.clockActiveMs > 0
                ? `${(today.agentActiveMs / today.clockActiveMs).toFixed(2)}× parallel`
                : '—'
            }
            title="Sum of every session's active time. Two agents working for an hour each is two agent-hours."
          />
          <Stat
            label="Sessions"
            value={String(today?.sessionCount ?? 0)}
            sub={
              today
                ? `${fmtClock(today.firstActivityTs)} – ${fmtClock(today.lastActivityTs)}`
                : 'no activity'
            }
          />
          <Stat
            label="Peak concurrency"
            value={String(today?.peakConcurrency ?? 0)}
            sub={
              today?.peakConcurrencyAt
                ? `at ${fmtClock(today.peakConcurrencyAt)} · avg ${today.avgConcurrency.toFixed(2)}`
                : '—'
            }
            title="Highest number of sessions active at the same instant."
          />
          <Stat label="Tool calls" value={fmtCompact(today?.toolCalls ?? 0)} sub={`${today?.userPrompts ?? 0} prompts`} />
          <Stat
            label="Cost"
            kind="measured"
            value={today?.hasCostData ? fmtCost(today.costUsd) : 'n/a'}
            sub={today?.hasCostData ? 'from provider logs' : 'no provider reported cost'}
          />
        </Tiles>
      </Panel>

      <Panel
        title={`Last ${days} days`}
        actions={
          <div className="legend">
            <span>
              <i style={{ background: 'var(--codex)' }} />
              Codex
            </span>
            <span>
              <i style={{ background: 'var(--claude)' }} />
              Claude Code
            </span>
            <span>
              <i
                style={{
                  background: 'transparent',
                  borderTop: '2px dashed var(--accent)',
                  height: 0,
                  width: 14,
                }}
              />
              clock time (≥1 active)
            </span>
          </div>
        }
      >
        <DailyBars days={data.days} onSelect={onPickDay} />
        <div className="tiles" style={{ marginTop: 12, border: '1px solid var(--border)' }}>
          <Stat label="Sessions" value={String(totals.sessionCount)} />
          <Stat label="Clock time" kind="estimate" value={fmtDuration(totals.clockActiveMs)} />
          <Stat label="Agent time" kind="estimate" value={fmtDuration(totals.agentActiveMs)} />
          <Stat label="Tool calls" value={fmtCompact(totals.toolCalls)} />
          <Stat label="Tokens (in+out)" value={fmtCompact(tokenTotal(totals.tokens))} />
          <Stat
            label="Cost"
            kind="measured"
            value={totals.hasCostData ? fmtCost(totals.costUsd) : 'n/a'}
          />
        </div>
      </Panel>

      <Panel title="Possibly running now" flush>
        {data.live.length === 0 ? (
          <div className="empty">
            No session has written to its log recently. Nothing appears to be running.
          </div>
        ) : (
          <div className="scroll-x">
            <table className="grid fixed" style={{ minWidth: 980 }}>
              <thead>
                <tr>
                  <th style={{ width: 26 }} />
                  <th style={{ width: 140 }}>Status</th>
                  <th>Session</th>
                  <th style={{ width: 110 }}>Provider</th>
                  <th style={{ width: 100 }}>Host</th>
                  <th style={{ width: 380 }}>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {data.live.map((s) => (
                  <tr key={s.key} className="clickable" onClick={() => onPickSession(s.key)}>
                    <td>
                      <span className={`dot ${s.live.status}`} />
                    </td>
                    <td>
                      <strong>{LIVE_LABEL[s.live.status]}</strong>
                      <div className="faint" style={{ fontSize: 11 }}>
                        {s.live.confidence} confidence
                      </div>
                    </td>
                    <td>
                      <div className="truncate">{s.title ?? s.sessionId}</div>
                      <div className="faint truncate mono" style={{ fontSize: 11 }}>
                        {s.cwd}
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${s.provider}`}>{PROVIDER_LABEL[s.provider]}</span>
                    </td>
                    <td className="dim mono" style={{ fontSize: 11 }}>
                      {s.host.label}
                    </td>
                    <td className="faint" style={{ fontSize: 11 }}>
                      {s.live.evidence.join(' · ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="note">
        <strong>Reading these numbers.</strong> “Clock time” counts each minute once, however many
        agents were running. “Agent time” adds every session up, so it can exceed the length of the
        day. Both are estimated from log event timestamps using the idle threshold in Settings — they
        are not a measure of model compute. Where a provider records its own timings or cost, those
        appear separately and are labelled <em>measured</em>.
      </div>
    </>
  );
}
