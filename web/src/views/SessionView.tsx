import type { NormalizedEvent, SessionDetail } from '@core/types';
import { useEffect, useMemo, useState } from 'react';

import { Panel, Stat, Tiles } from '../components/Tiles';
import { api } from '../lib/api';
import {
  fmtClockSec,
  fmtCompact,
  fmtCost,
  PROVIDER_LABEL,
  tokenTotal,
  useFormat,
} from '../lib/format';
import { useI18n, type MessageKey } from '../lib/i18n';

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
  const { t } = useI18n();
  const f = useFormat();
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
        {t('session.loadFailed', { error })}{' '}
        <button className="btn" onClick={onBack}>
          {t('common.back')}
        </button>
      </div>
    );
  }
  if (!detail) return <div className="empty">{t('session.loading')}</div>;

  const measured = detail.measured;
  const hasMeasured =
    measured.apiMs !== undefined || measured.toolMs !== undefined || measured.totalMs !== undefined;

  return (
    <>
      <Panel
        title={t('session.title')}
        actions={
          <button className="btn" onClick={onBack}>
            {t('common.back')}
          </button>
        }
        flush
      >
        <div className="panel-body">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className={`badge ${detail.provider}`}>{PROVIDER_LABEL[detail.provider]}</span>
            <span className="badge">{detail.host.label}</span>
            {detail.isSubagent && (
              <span className="badge">
                {t('session.subagent')}
                {detail.agentLabel ? `: ${detail.agentLabel}` : ''}
              </span>
            )}
            <span className={`dot ${detail.live.status}`} />
            <span className="dim">
              {t(`live.${detail.live.status}` as MessageKey)} ·{' '}
              {t('overview.confidence', {
                level: t(`live.${detail.live.confidence}` as MessageKey),
              })}
            </span>
          </div>
          <h3 style={{ margin: '8px 0 6px', fontSize: 15, overflowWrap: 'anywhere' }}>
            {detail.title ?? detail.sessionId}
          </h3>
          <dl className="kv">
            <dt>{t('session.id')}</dt>
            <dd className="mono">{detail.sessionId}</dd>
            <dt>{t('session.cwd')}</dt>
            <dd className="mono">{detail.cwd ?? '—'}</dd>
            {detail.gitBranch && (
              <>
                <dt>{t('session.branch')}</dt>
                <dd className="mono">{detail.gitBranch}</dd>
              </>
            )}
            <dt>{t('session.models')}</dt>
            <dd className="mono">{detail.models.length > 0 ? detail.models.join(', ') : '—'}</dd>
            <dt>{t('session.cliVersion')}</dt>
            <dd className="mono">{detail.cliVersion ?? '—'}</dd>
            <dt>{t('session.started')}</dt>
            <dd className="mono">{f.dateTime(detail.startedAt)}</dd>
            <dt>{t('session.lastEvent')}</dt>
            <dd className="mono">{f.dateTime(detail.endedAt)}</dd>
            <dt>{t('session.logFile')}</dt>
            <dd className="mono faint" style={{ fontSize: 11 }}>
              {detail.filePath}
            </dd>
            <dt>{t('session.evidence')}</dt>
            <dd className="faint">{detail.live.evidence.join(' · ')}</dd>
          </dl>
        </div>

        <Tiles>
          <Stat
            label={t('session.wallSpan')}
            value={f.duration(detail.wallSpanMs)}
            sub={t('session.wallSpanSub')}
            title={t('session.wallSpanTitle')}
          />
          <Stat
            label={t('session.active')}
            kind="estimate"
            value={f.duration(detail.activity.activeMs)}
            sub={t('session.activeSub', { n: detail.activity.segments.length })}
            title={t('session.activeTitle', {
              minutes: Math.round(detail.activity.idleThresholdMs / 60000),
            })}
          />
          <Stat
            label={t('session.idle')}
            kind="estimate"
            value={f.duration(detail.activity.idleMs)}
            sub={t('session.idleSub', { n: detail.activity.idleGaps.length })}
          />
          <Stat
            label={t('session.apiTime')}
            kind="measured"
            value={measured.apiMs !== undefined ? f.duration(measured.apiMs) : t('common.na')}
            sub={measured.apiMs !== undefined ? measured.source : t('session.apiTimeNone')}
            title={measured.source}
          />
          <Stat
            label={t('session.toolTime')}
            kind="measured"
            value={measured.toolMs !== undefined ? f.duration(measured.toolMs) : t('common.na')}
            sub={measured.toolMs !== undefined ? t('session.toolTimeSub') : t('common.notRecorded')}
          />
          <Stat
            label={t('session.cost')}
            kind="measured"
            value={detail.costUsd == null ? t('common.na') : fmtCost(detail.costUsd)}
          />
        </Tiles>

        <Tiles>
          <Stat label={t('session.prompts')} value={String(detail.counters.userPrompts)} />
          <Stat label={t('session.toolCalls')} value={String(detail.counters.toolCalls)} />
          <Stat
            label={t('session.assistantMessages')}
            value={String(detail.counters.assistantMessages)}
          />
          <Stat label={t('session.errors')} value={String(detail.counters.errors)} />
          <Stat label={t('session.compactions')} value={String(detail.counters.compactions)} />
          <Stat
            label={t('session.tokens')}
            value={fmtCompact(tokenTotal(detail.tokens))}
            sub={t('session.cacheRead', { n: fmtCompact(detail.tokens.cacheRead ?? 0) })}
          />
        </Tiles>
      </Panel>

      {!hasMeasured && <div className="note">{t('session.noMeasured')}</div>}

      <div className="split">
        <Panel title={t('session.phases', { n: detail.phases.length })}>
          {detail.phases.length === 0 ? (
            <div className="empty">{t('session.noPhases')}</div>
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
                    {f.duration(p.endTs - p.startTs)} ·{' '}
                    {t('session.phaseMeta', { toolCalls: p.toolCalls })}
                    {tokenTotal(p.tokens) > 0 ? ` · ${fmtCompact(tokenTotal(p.tokens))} tok` : ''}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title={t('session.idleGaps', { n: detail.activity.idleGaps.length })}>
          {detail.activity.idleGaps.length === 0 ? (
            <div className="empty">{t('session.noIdleGaps')}</div>
          ) : (
            <table className="grid">
              <thead>
                <tr>
                  <th className="num">{t('session.gapFrom')}</th>
                  <th className="num">{t('session.gapTo')}</th>
                  <th className="num">{t('session.gapDuration')}</th>
                </tr>
              </thead>
              <tbody>
                {detail.activity.idleGaps.map((g, i) => (
                  <tr key={i}>
                    <td className="num">{fmtClockSec(g.start)}</td>
                    <td className="num">{fmtClockSec(g.end)}</td>
                    <td className="num">{f.duration(g.durationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      <Panel
        title={t('session.events', { shown: filtered.length, total: detail.events.length })}
        actions={
          <div className="controls">
            <input
              type="text"
              placeholder={t('session.search')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ minWidth: 200 }}
            />
            <button className="btn" onClick={() => setShowRaw((v) => !v)}>
              {showRaw ? t('session.hideRaw') : t('session.showRaw')}
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
                style={
                  kinds.has(k) ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined
                }
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
                {t('common.clear')}
              </button>
            )}
          </div>
        </div>

        {detail.eventsTruncated && (
          <div className="note warn" style={{ margin: '0 12px 8px' }}>
            {t('session.truncated')}
          </div>
        )}

        <div className="scroll-y" style={{ maxHeight: 620 }}>
          {filtered.slice(0, 5000).map((e, i) => (
            <EventRow key={i} event={e} showRaw={showRaw} format={f} />
          ))}
          {filtered.length > 5000 && <div className="empty">{t('session.tooMany')}</div>}
        </div>
      </Panel>

      <div className="note">{t('session.privacyNote')}</div>

      {detail.providerMeta && Object.keys(detail.providerMeta).length > 0 && (
        <Panel title={t('session.providerMeta')}>
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

/**
 * Event kinds stay untranslated on purpose: they are the normalized model's own
 * vocabulary, and the same words appear in the API, the logs and the docs.
 */
function EventRow({
  event,
  showRaw,
  format,
}: {
  event: NormalizedEvent;
  showRaw: boolean;
  format: ReturnType<typeof useFormat>;
}): React.ReactElement {
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
        {event.durationMs !== undefined && format.durationPrecise(event.durationMs)}
        {event.exitCode !== undefined && (
          <span style={{ color: event.exitCode === 0 ? 'var(--ok)' : 'var(--danger)' }}>
            {' '}
            exit {event.exitCode}
          </span>
        )}
        {event.tokens?.total !== undefined && ` ${format.number(event.tokens.total)} tok`}
      </div>
    </div>
  );
}
