import type { NormalizedEvent, SessionDetail } from '@core/types';
import { useEffect, useMemo, useState } from 'react';

import { Panel, Stat, Tiles } from '../components/Tiles';
import { api } from '../lib/api';
import {
  fmtClockSec,
  fmtCompact,
  fmtCost,
  fmtDateTime,
  fmtDuration,
  fmtDurationPrecise,
  fmtNumber,
  LIVE_LABEL,
  PROVIDER_LABEL,
  tokenTotal,
} from '../lib/format';

const KIND_ORDER = [
  'user_prompt',
  'assistant_message',
  'tool_call',
  'tool_result',
  'reasoning',
  'model_usage',
  'turn_start',
  'turn_end',
  'compaction',
  'error',
  'system',
  'session_start',
] as const;

export function SessionView({
  sessionKey,
  onBack,
}: {
  sessionKey: string;
  onBack: () => void;
}): React.ReactElement {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [kinds, setKinds] = useState<Set<string>>(new Set());
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    api
      .session(sessionKey)
      .then((d) => !cancelled && setDetail(d))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [sessionKey]);

  const filtered = useMemo(() => {
    if (!detail) return [];
    const q = query.trim().toLowerCase();
    return detail.events.filter((e) => {
      if (kinds.size > 0 && !kinds.has(e.kind)) return false;
      if (!q) return true;
      return (
        (e.summary ?? '').toLowerCase().includes(q) ||
        (e.toolName ?? '').toLowerCase().includes(q) ||
        (e.subtype ?? '').toLowerCase().includes(q)
      );
    });
  }, [detail, query, kinds]);

  const kindCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of detail?.events ?? []) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
    return counts;
  }, [detail]);

  if (error) {
    return (
      <div className="note warn">
        Failed to load session: {error}{' '}
        <button className="btn" onClick={onBack}>
          back
        </button>
      </div>
    );
  }
  if (!detail) return <div className="empty">Loading session…</div>;

  const measured = detail.measured;
  const hasMeasured =
    measured.apiMs !== undefined || measured.toolMs !== undefined || measured.totalMs !== undefined;

  return (
    <>
      <Panel
        title="Session"
        actions={
          <button className="btn" onClick={onBack}>
            ← back
          </button>
        }
        flush
      >
        <div className="panel-body">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className={`badge ${detail.provider}`}>{PROVIDER_LABEL[detail.provider]}</span>
            <span className="badge">{detail.host.label}</span>
            {detail.isSubagent && <span className="badge">subagent{detail.agentLabel ? `: ${detail.agentLabel}` : ''}</span>}
            <span className={`dot ${detail.live.status}`} />
            <span className="dim">
              {LIVE_LABEL[detail.live.status]} ({detail.live.confidence} confidence)
            </span>
          </div>
          <h3 style={{ margin: '8px 0 6px', fontSize: 15, overflowWrap: 'anywhere' }}>
            {detail.title ?? detail.sessionId}
          </h3>
          <dl className="kv">
            <dt>session id</dt>
            <dd className="mono">{detail.sessionId}</dd>
            <dt>working dir</dt>
            <dd className="mono">{detail.cwd ?? '—'}</dd>
            {detail.gitBranch && (
              <>
                <dt>git branch</dt>
                <dd className="mono">{detail.gitBranch}</dd>
              </>
            )}
            <dt>models</dt>
            <dd className="mono">{detail.models.length > 0 ? detail.models.join(', ') : '—'}</dd>
            <dt>cli version</dt>
            <dd className="mono">{detail.cliVersion ?? '—'}</dd>
            <dt>started</dt>
            <dd className="mono">{fmtDateTime(detail.startedAt)}</dd>
            <dt>last event</dt>
            <dd className="mono">{fmtDateTime(detail.endedAt)}</dd>
            <dt>log file</dt>
            <dd className="mono faint" style={{ fontSize: 11 }}>
              {detail.filePath}
            </dd>
            <dt>evidence</dt>
            <dd className="faint">{detail.live.evidence.join(' · ')}</dd>
          </dl>
        </div>

        <Tiles>
          <Stat
            label="Wall span"
            value={fmtDuration(detail.wallSpanMs)}
            sub="first event → last event"
            title="A fact about the log: the time between the first and last recorded event."
          />
          <Stat
            label="Active"
            kind="estimate"
            value={fmtDuration(detail.activity.activeMs)}
            sub={`${detail.activity.segments.length} segments`}
            title={`Sum of activity segments, split at gaps longer than ${Math.round(
              detail.activity.idleThresholdMs / 60000,
            )} minutes. A lower bound, not model compute time.`}
          />
          <Stat
            label="Idle"
            kind="estimate"
            value={fmtDuration(detail.activity.idleMs)}
            sub={`${detail.activity.idleGaps.length} gaps`}
          />
          <Stat
            label="API time"
            kind="measured"
            value={measured.apiMs !== undefined ? fmtDuration(measured.apiMs) : 'n/a'}
            sub={measured.apiMs !== undefined ? measured.source : 'not recorded for this session'}
            title={measured.source}
          />
          <Stat
            label="Tool time"
            kind="measured"
            value={measured.toolMs !== undefined ? fmtDuration(measured.toolMs) : 'n/a'}
            sub={measured.toolMs !== undefined ? 'reported by provider' : 'not recorded'}
          />
          <Stat
            label="Cost"
            kind="measured"
            value={detail.costUsd == null ? 'n/a' : fmtCost(detail.costUsd)}
          />
        </Tiles>

        <Tiles>
          <Stat label="Prompts" value={String(detail.counters.userPrompts)} />
          <Stat label="Tool calls" value={String(detail.counters.toolCalls)} />
          <Stat label="Assistant messages" value={String(detail.counters.assistantMessages)} />
          <Stat label="Errors" value={String(detail.counters.errors)} />
          <Stat label="Compactions" value={String(detail.counters.compactions)} />
          <Stat
            label="Tokens (in+out)"
            value={fmtCompact(tokenTotal(detail.tokens))}
            sub={`cache read ${fmtCompact(detail.tokens.cacheRead ?? 0)}`}
          />
        </Tiles>
      </Panel>

      {!hasMeasured && (
        <div className="note">
          This provider did not record API or tool timings for this session, so only estimates are
          shown. Nothing here is inferred from anything other than event timestamps in the log.
        </div>
      )}

      <div className="split">
        <Panel title={`Phases (${detail.phases.length})`}>
          {detail.phases.length === 0 ? (
            <div className="empty">No phases.</div>
          ) : (
            <div className="scroll-y" style={{ maxHeight: 420 }}>
              {detail.phases.map((p) => (
                <div className="phase" key={p.index}>
                  <div className="title">
                    <span className="faint mono">#{p.index} </span>
                    {p.title}
                  </div>
                  <div className="meta">
                    {fmtClockSec(p.startTs)} → {fmtClockSec(p.endTs)} ·{' '}
                    {fmtDuration(p.endTs - p.startTs)} · {p.toolCalls} tool calls
                    {tokenTotal(p.tokens) > 0 ? ` · ${fmtCompact(tokenTotal(p.tokens))} tok` : ''}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title={`Idle gaps (${detail.activity.idleGaps.length})`}>
          {detail.activity.idleGaps.length === 0 ? (
            <div className="empty">No gap longer than the idle threshold.</div>
          ) : (
            <table className="grid">
              <thead>
                <tr>
                  <th className="num">From</th>
                  <th className="num">To</th>
                  <th className="num">Duration</th>
                </tr>
              </thead>
              <tbody>
                {detail.activity.idleGaps.map((g, i) => (
                  <tr key={i}>
                    <td className="num">{fmtClockSec(g.start)}</td>
                    <td className="num">{fmtClockSec(g.end)}</td>
                    <td className="num">{fmtDuration(g.durationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      <Panel
        title={`Events (${filtered.length} of ${detail.events.length})`}
        actions={
          <div className="controls">
            <input
              type="text"
              placeholder="search events…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ minWidth: 200 }}
            />
            <button className="btn" onClick={() => setShowRaw((v) => !v)}>
              {showRaw ? 'hide raw fields' : 'show raw fields'}
            </button>
          </div>
        }
        flush
      >
        <div className="panel-body" style={{ paddingBottom: 6 }}>
          <div className="controls">
            {KIND_ORDER.filter((k) => kindCounts.has(k)).map((k) => (
              <button
                key={k}
                className="btn"
                aria-pressed={kinds.has(k)}
                style={kinds.has(k) ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
                onClick={() =>
                  setKinds((prev) => {
                    const next = new Set(prev);
                    if (next.has(k)) next.delete(k);
                    else next.add(k);
                    return next;
                  })
                }
              >
                {k} <span className="faint">{kindCounts.get(k)}</span>
              </button>
            ))}
            {kinds.size > 0 && (
              <button className="btn" onClick={() => setKinds(new Set())}>
                clear
              </button>
            )}
          </div>
        </div>

        {detail.eventsTruncated && (
          <div className="note warn" style={{ margin: '0 12px 8px' }}>
            This session has more events than the viewer displays; the list is truncated.
          </div>
        )}

        <div className="scroll-y" style={{ maxHeight: 620 }}>
          {filtered.slice(0, 5000).map((e, i) => (
            <EventRow key={i} event={e} showRaw={showRaw} />
          ))}
          {filtered.length > 5000 && (
            <div className="empty">Showing the first 5000 matching events. Narrow the search.</div>
          )}
        </div>
      </Panel>

      <div className="note">
        Prompt and tool text shown here is read from your local log files and never leaves this
        machine. This page makes no network requests other than to this app on 127.0.0.1.
      </div>

      {detail.providerMeta && Object.keys(detail.providerMeta).length > 0 && (
        <Panel title="Provider metadata">
          <pre
            className="mono"
            style={{ margin: 0, fontSize: 11, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
          >
            {JSON.stringify(detail.providerMeta, null, 2)}
          </pre>
        </Panel>
      )}
    </>
  );
}

function EventRow({ event, showRaw }: { event: NormalizedEvent; showRaw: boolean }): React.ReactElement {
  const label = event.toolName ? `${event.kind} · ${event.toolName}` : event.kind;
  return (
    <div className="evt">
      <time>{fmtClockSec(event.ts)}</time>
      <div className={`kind ${event.kind}`} title={event.subtype}>
        {label}
      </div>
      <div className={`body${event.kind === 'user_prompt' ? ' prompt' : ''}`}>
        {event.summary ?? <span className="faint">{event.subtype ?? ''}</span>}
        {showRaw && (
          <div className="faint" style={{ fontSize: 10.5 }}>
            {JSON.stringify({
              subtype: event.subtype,
              callId: event.callId,
              model: event.model,
              tokens: event.tokens,
              meta: event.meta,
            })}
          </div>
        )}
      </div>
      <div className="mono faint" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
        {event.durationMs !== undefined && fmtDurationPrecise(event.durationMs)}
        {event.exitCode !== undefined && (
          <span style={{ color: event.exitCode === 0 ? 'var(--ok)' : 'var(--danger)' }}>
            {' '}
            exit {event.exitCode}
          </span>
        )}
        {event.tokens?.total !== undefined && ` ${fmtNumber(event.tokens.total)} tok`}
      </div>
    </div>
  );
}
