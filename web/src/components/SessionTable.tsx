import type { SessionSummary } from '@core/types';

import {
  fmtClock,
  fmtCost,
  fmtCompact,
  fmtDuration,
  LIVE_LABEL,
  PROVIDER_LABEL,
  shortPath,
  tokenTotal,
} from '../lib/format';

/**
 * Session list.
 *
 * Wall span and active estimate sit next to each other on purpose — seeing
 * "4h 20m / 41m" in one row is what stops anyone reading a long session as a
 * long stretch of agent work.
 */
export function SessionTable({
  sessions,
  onSelect,
  selectedKey,
  showDate,
}: {
  sessions: SessionSummary[];
  onSelect: (key: string) => void;
  selectedKey?: string | null;
  showDate?: boolean;
}): React.ReactElement {
  if (sessions.length === 0) {
    return <div className="empty">No sessions in this range.</div>;
  }

  return (
    <div className="scroll-x">
      <table className="grid fixed" style={{ minWidth: 1100 }}>
        <thead>
          <tr>
            <th style={{ width: 26 }} />
            <th>Session</th>
            <th style={{ width: 110 }}>Provider</th>
            <th style={{ width: 100 }}>Host</th>
            <th className="num" style={{ width: 62 }}>
              Start
            </th>
            <th className="num" style={{ width: 62 }}>
              End
            </th>
            <th className="num" style={{ width: 72 }} title="Last event minus first event">
              Wall
            </th>
            <th
              className="num"
              style={{ width: 92 }}
              title="Sum of active segments (estimate, lower bound)"
            >
              Active (est.)
            </th>
            <th className="num" style={{ width: 72 }}>
              Idle
            </th>
            <th className="num" style={{ width: 72 }}>
              Prompts
            </th>
            <th className="num" style={{ width: 62 }}>
              Tools
            </th>
            <th
              className="num"
              style={{ width: 76 }}
              title="Input + output tokens reported in the log"
            >
              Tokens
            </th>
            <th
              className="num"
              style={{ width: 78 }}
              title="Only providers that record cost report a value"
            >
              Cost
            </th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr
              key={s.key}
              className="clickable"
              onClick={() => onSelect(s.key)}
              style={
                selectedKey === s.key ? { outline: '1px solid var(--accent)', outlineOffset: -1 } : undefined
              }
            >
              <td title={`${LIVE_LABEL[s.live.status]} (${s.live.confidence} confidence)`}>
                <span className={`dot ${s.live.status}`} />
              </td>
              <td>
                <div className="truncate" title={s.title ?? s.sessionId}>
                  {s.isSubagent && <span className="faint">↳ </span>}
                  {s.title ?? s.sessionId}
                </div>
                <div className="faint truncate mono" style={{ fontSize: 11 }} title={s.cwd}>
                  {shortPath(s.cwd, 52)}
                  {s.gitBranch ? ` · ${s.gitBranch}` : ''}
                </div>
              </td>
              <td>
                <span className={`badge ${s.provider}`}>{PROVIDER_LABEL[s.provider]}</span>
              </td>
              <td className="dim mono" style={{ fontSize: 11 }}>
                {s.host.label}
              </td>
              <td className="num">
                {showDate && <span className="faint">{new Date(s.startedAt).toLocaleDateString()} </span>}
                {fmtClock(s.startedAt)}
              </td>
              <td className="num">{fmtClock(s.endedAt)}</td>
              <td className="num dim">{fmtDuration(s.wallSpanMs)}</td>
              <td className="num">{fmtDuration(s.activity.activeMs)}</td>
              <td className="num faint">{fmtDuration(s.activity.idleMs)}</td>
              <td className="num">{s.counters.userPrompts}</td>
              <td className="num">{s.counters.toolCalls}</td>
              <td className="num dim">{fmtCompact(tokenTotal(s.tokens))}</td>
              <td className="num dim">{s.costUsd == null ? 'n/a' : fmtCost(s.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
