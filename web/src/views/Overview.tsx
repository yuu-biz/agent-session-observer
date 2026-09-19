import type { OverviewResponse } from '@api/api';
import type { ProviderId } from '@core/types';
import { useEffect, useState } from 'react';

import { DailyBars } from '../components/DailyBars';
import { Panel, Stat, Tiles } from '../components/Tiles';
import { api } from '../lib/api';
import { fmtClock, fmtCompact, fmtCost, PROVIDER_LABEL, tokenTotal, useFormat } from '../lib/format';
import { useI18n, type MessageKey } from '../lib/i18n';

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
  const { t } = useI18n();
  const f = useFormat();
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

  if (error) return <div className="note warn">{t('day.loadFailed', { error })}</div>;
  if (!data) return <div className="empty">{t('common.loading')}</div>;

  const today = data.today;
  const totals = data.totals;
  const roi = data.roi;

  /**
   * Cost is shown with its provenance attached, never as a bare number: a
   * measured figure and a price-list estimate look identical in a tile, and
   * only one of them is a fact.
   */
  const basisSub =
    roi.costBasis === 'measured'
      ? t('overview.costBasisMeasured')
      : roi.costBasis === 'estimated'
        ? t('overview.costBasisEstimated')
        : roi.costBasis === 'mixed'
          ? t('overview.costBasisMixed')
          : t('overview.costNone');
  const rangeCostKind = roi.costBasis === 'measured' ? 'measured' : 'estimate';

  const todayCost = today?.hasCostData
    ? {
        // A day that mixes the two is labelled as an estimate: the total is
        // only as trustworthy as its least certain part.
        kind: (today.hasEstimatedCost ? 'estimate' : 'measured') as 'estimate' | 'measured',
        value: fmtCost((today.costUsd ?? 0) + (today.estimatedCostUsd ?? 0)),
        sub: today.hasEstimatedCost
          ? t('cost.totalSub', {
              measured: fmtCost(today.costUsd),
              estimated: fmtCost(today.estimatedCostUsd),
            })
          : t('overview.costFrom'),
      }
    : today?.hasEstimatedCost
      ? {
          kind: 'estimate' as const,
          value: fmtCost(today.estimatedCostUsd),
          sub: t('overview.costBasisEstimated'),
        }
      : { kind: 'measured' as const, value: t('common.na'), sub: t('overview.costNone') };

  return (
    <>
      <Panel
        title={`${t('overview.today')} · ${data.days[data.days.length - 1]?.dayKey ?? ''}`}
        flush
      >
        <Tiles>
          <Stat
            label={t('overview.clockActive')}
            kind="estimate"
            value={f.duration(today?.clockActiveMs ?? 0)}
            sub={t('overview.clockActiveSub')}
            title={t('overview.clockActiveTitle')}
          />
          <Stat
            label={t('overview.agentTime')}
            kind="estimate"
            value={f.duration(today?.agentActiveMs ?? 0)}
            sub={
              today && today.clockActiveMs > 0
                ? t('overview.parallel', {
                    x: (today.agentActiveMs / today.clockActiveMs).toFixed(2),
                  })
                : '—'
            }
            title={t('overview.agentTimeTitle')}
          />
          <Stat
            label={t('overview.sessions')}
            value={String(today?.sessionCount ?? 0)}
            sub={
              today
                ? `${fmtClock(today.firstActivityTs)} – ${fmtClock(today.lastActivityTs)}`
                : t('overview.noActivity')
            }
          />
          <Stat
            label={t('overview.peak')}
            value={String(today?.peakConcurrency ?? 0)}
            sub={
              today?.peakConcurrencyAt
                ? t('overview.peakAt', {
                    time: fmtClock(today.peakConcurrencyAt),
                    avg: today.avgConcurrency.toFixed(2),
                  })
                : '—'
            }
            title={t('overview.peakTitle')}
          />
          <Stat
            label={t('overview.toolCalls')}
            value={fmtCompact(today?.toolCalls ?? 0)}
            sub={t('overview.prompts', { n: today?.userPrompts ?? 0 })}
          />
          <Stat
            label={t('overview.cost')}
            kind={todayCost.kind}
            value={todayCost.value}
            sub={todayCost.sub}
          />
        </Tiles>
      </Panel>

      <Panel
        title={t('overview.lastDays', { n: days })}
        actions={
          <div className="legend">
            <span>
              <i style={{ background: 'var(--codex)' }} />
              {t('common.codex')}
            </span>
            <span>
              <i style={{ background: 'var(--claude)' }} />
              {t('common.claudeCode')}
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
              {t('overview.legendClock')}
            </span>
          </div>
        }
      >
        <DailyBars days={data.days} onSelect={onPickDay} />
        <div className="tiles" style={{ marginTop: 12, border: '1px solid var(--border)' }}>
          <Stat label={t('overview.totalSessions')} value={String(totals.sessionCount)} />
          <Stat
            label={t('overview.totalClock')}
            kind="estimate"
            value={f.duration(totals.clockActiveMs)}
          />
          <Stat
            label={t('overview.totalAgent')}
            kind="estimate"
            value={f.duration(totals.agentActiveMs)}
          />
          <Stat label={t('overview.toolCalls')} value={fmtCompact(totals.toolCalls)} />
          <Stat label={t('overview.tokens')} value={fmtCompact(tokenTotal(totals.tokens))} />
          <Stat
            label={t('overview.cost')}
            kind={rangeCostKind}
            value={roi.costUsd == null ? t('common.na') : fmtCost(roi.costUsd)}
            sub={basisSub}
          />
        </div>
      </Panel>

      <Panel title={t('overview.efficiency')} flush>
        <Tiles>
          <Stat
            label={t('cost.perTask')}
            kind={rangeCostKind}
            value={roi.costPerTaskUsd == null ? t('common.na') : fmtCost(roi.costPerTaskUsd)}
            sub={t('cost.perTaskSub', { n: f.number(roi.tasks) })}
            title={t('cost.perTaskTitle')}
          />
          <Stat
            label={t('cost.activePerTask')}
            kind="estimate"
            value={roi.agentMsPerTask == null ? t('common.na') : f.durationPrecise(roi.agentMsPerTask)}
            sub={t('cost.activePerTaskSub')}
            title={t('cost.activePerTaskTitle')}
          />
          <Stat
            label={t('cost.perAgentHour')}
            kind={rangeCostKind}
            value={
              roi.costPerAgentHourUsd == null ? t('common.na') : fmtCost(roi.costPerAgentHourUsd)
            }
            title={t('cost.perAgentHourTitle')}
          />
          <Stat
            label={t('cost.parallelism')}
            kind="estimate"
            value={roi.parallelism == null ? t('common.na') : `${roi.parallelism.toFixed(2)}×`}
            sub={t('cost.parallelismSub')}
          />
          <Stat
            label={t('cost.tokensPerTask')}
            value={
              roi.tokensPerTask == null ? t('common.na') : fmtCompact(Math.round(roi.tokensPerTask))
            }
            sub={`${t('cost.cacheHit')} ${
              roi.cacheHitRate == null ? t('common.na') : `${(roi.cacheHitRate * 100).toFixed(0)}%`
            }`}
          />
          <Stat
            label={t('cost.cacheSaved')}
            kind="estimate"
            value={roi.cacheSavingsUsd == null ? t('common.na') : fmtCost(roi.cacheSavingsUsd)}
            sub={t('cost.cacheSavedSub')}
          />
        </Tiles>
        <div className="panel-body dim" style={{ fontSize: 11.5 }}>
          {t('overview.seeCost')}
        </div>
      </Panel>

      <Panel title={t('overview.liveTitle')} flush>
        {data.live.length === 0 ? (
          <div className="empty">{t('overview.liveEmpty')}</div>
        ) : (
          <div className="scroll-x">
            <table className="grid fixed" style={{ minWidth: 980 }}>
              <thead>
                <tr>
                  <th style={{ width: 26 }} />
                  <th style={{ width: 150 }}>{t('overview.colStatus')}</th>
                  <th>{t('overview.colSession')}</th>
                  <th style={{ width: 110 }}>{t('overview.colProvider')}</th>
                  <th style={{ width: 100 }}>{t('overview.colHost')}</th>
                  <th style={{ width: 380 }}>{t('overview.colEvidence')}</th>
                </tr>
              </thead>
              <tbody>
                {data.live.map((s) => (
                  <tr key={s.key} className="clickable" onClick={() => onPickSession(s.key)}>
                    <td>
                      <span className={`dot ${s.live.status}`} />
                    </td>
                    <td>
                      <strong>{t(`live.${s.live.status}` as MessageKey)}</strong>
                      <div className="faint" style={{ fontSize: 11 }}>
                        {t('overview.confidence', {
                          level: t(`live.${s.live.confidence}` as MessageKey),
                        })}
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
        <strong>{t('overview.noteLead')}</strong> {t('overview.note')}
      </div>
    </>
  );
}
