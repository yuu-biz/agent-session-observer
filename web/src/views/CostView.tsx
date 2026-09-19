import type { CostResponse, DailyCost } from '@api/api';
import type { ModelRollup } from '@core/aggregate';
import type { ProviderId } from '@core/types';
import { useEffect, useState } from 'react';

import { Panel, Stat, Tiles } from '../components/Tiles';
import { api } from '../lib/api';
import { fmtCompact, fmtCost, PROVIDER_LABEL, useFormat } from '../lib/format';
import { useI18n, type MessageKey, type Translate } from '../lib/i18n';

/**
 * Cost and unit economics.
 *
 * The screen exists to answer "what does a unit of work cost, and is that
 * moving" — a question totals cannot answer. Two rules shape everything on it:
 *
 *  - a figure the provider wrote down and a figure this app derived from a
 *    price list are never added into an unlabelled total, and the basis is on
 *    screen wherever money is;
 *  - a metric with no denominator reads "n/a", never 0.00, because a zero
 *    here averages straight into somebody's budget.
 */

/** `null` becomes an explicit "n/a" rather than a zero. */
function money(usd: number | null | undefined, na: string): string {
  return usd == null ? na : fmtCost(usd);
}

function percent(v: number | null, na: string): string {
  return v == null ? na : `${(v * 100).toFixed(0)}%`;
}

function ratio(v: number | null, na: string, digits = 1): string {
  return v == null ? na : v.toFixed(digits);
}

function basisLabel(t: Translate, basis: string): string {
  return t(`cost.basis.${basis}` as MessageKey);
}

export function CostView({
  days,
  provider,
  refreshToken,
}: {
  days: number;
  provider: ProviderId | 'all';
  refreshToken: number;
}): React.ReactElement {
  const { t } = useI18n();
  const f = useFormat();
  const [data, setData] = useState<CostResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .cost(days, provider)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError(null);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [days, provider, refreshToken]);

  if (error) return <div className="note warn">{t('cost.loadFailed', { error })}</div>;
  if (!data) return <div className="empty">{t('common.loading')}</div>;

  const { roi } = data;
  const na = t('common.na');
  const costKind = roi.costBasis === 'measured' ? 'measured' : 'estimate';

  return (
    <>
      <Panel title={t('cost.economics')} flush>
        <Tiles>
          <Stat
            label={t('cost.total')}
            kind={costKind}
            value={money(roi.costUsd, na)}
            sub={
              roi.costBasis === 'none'
                ? t('cost.totalNone')
                : t('cost.totalSub', {
                    measured: money(roi.measuredCostUsd, na),
                    estimated: money(roi.estimatedCostUsd, na),
                  })
            }
          />
          <Stat
            label={t('cost.perTask')}
            kind={costKind}
            value={money(roi.costPerTaskUsd, na)}
            sub={t('cost.perTaskSub', { n: f.number(roi.tasks) })}
            title={t('cost.perTaskTitle')}
          />
          <Stat
            label={t('cost.perSession')}
            kind={costKind}
            value={money(roi.costPerSessionUsd, na)}
            sub={t('cost.perSessionSub', { n: f.number(roi.sessions) })}
          />
          <Stat
            label={t('cost.perAgentHour')}
            kind={costKind}
            value={money(roi.costPerAgentHourUsd, na)}
            title={t('cost.perAgentHourTitle')}
          />
          <Stat
            label={t('cost.perMillion')}
            kind={costKind}
            value={money(roi.costPerMillionTokensUsd, na)}
          />
          <Stat
            label={t('cost.cacheSaved')}
            kind="estimate"
            value={money(roi.cacheSavingsUsd, na)}
            sub={t('cost.cacheSavedSub')}
          />
        </Tiles>

        <Tiles>
          <Stat
            label={t('cost.activePerTask')}
            kind="estimate"
            value={roi.agentMsPerTask == null ? na : f.durationPrecise(roi.agentMsPerTask)}
            sub={t('cost.activePerTaskSub')}
            title={t('cost.activePerTaskTitle')}
          />
          <Stat
            label={t('cost.clockPerTask')}
            kind="estimate"
            value={roi.clockMsPerTask == null ? na : f.durationPrecise(roi.clockMsPerTask)}
            sub={t('cost.clockPerTaskSub')}
          />
          <Stat
            label={t('cost.parallelism')}
            kind="estimate"
            value={roi.parallelism == null ? na : `${ratio(roi.parallelism, na, 2)}×`}
            sub={t('cost.parallelismSub')}
          />
          <Stat
            label={t('cost.toolsPerTask')}
            value={ratio(roi.toolCallsPerTask, na)}
          />
          <Stat
            label={t('cost.tokensPerTask')}
            value={roi.tokensPerTask == null ? na : fmtCompact(Math.round(roi.tokensPerTask))}
            sub={`${t('cost.cacheHit')} ${percent(roi.cacheHitRate, na)}`}
          />
          <Stat label={t('cost.errorRate')} value={ratio(roi.errorsPerHundredTasks, na)} />
        </Tiles>
      </Panel>

      <Panel
        title={t('cost.trend')}
        actions={
          <div className="legend">
            <span>
              <i style={{ background: 'var(--signal)' }} />
              {t('cost.legendMeasured')}
            </span>
            <span>
              <i
                style={{
                  background:
                    'repeating-linear-gradient(45deg, var(--signal) 0 3px, transparent 3px 7px)',
                }}
              />
              {t('cost.legendEstimated')}
            </span>
          </div>
        }
      >
        <SpendBars daily={data.daily} />
      </Panel>

      <Panel title={t('cost.byModel')} flush>
        {data.models.length === 0 ? (
          <div className="empty">{t('cost.empty')}</div>
        ) : (
          <ModelTable models={data.models} />
        )}
      </Panel>

      <Panel title={t('cost.byProvider')} flush>
        <div className="scroll-x">
          <table className="grid" style={{ minWidth: 880 }}>
            <thead>
              <tr>
                <th>{t('table.provider')}</th>
                <th className="num">{t('cost.colSessions')}</th>
                <th className="num">{t('cost.colTasks')}</th>
                <th className="num">{t('cost.colCost')}</th>
                <th className="num">{t('cost.colPerTask')}</th>
                <th className="num">{t('cost.colPerHour')}</th>
                <th className="num">{t('cost.colActivePerTask')}</th>
                <th className="num">{t('cost.colTokens')}</th>
                <th>{t('cost.colBasis')}</th>
              </tr>
            </thead>
            <tbody>
              {data.byProvider.map((p) => (
                <tr key={p.provider} className={`row-${p.provider}`}>
                  <td>
                    <span className={`badge ${p.provider}`}>{PROVIDER_LABEL[p.provider]}</span>
                  </td>
                  <td className="num">{p.sessionCount}</td>
                  <td className="num">{f.number(p.userPrompts)}</td>
                  <td className="num">{money(p.roi.costUsd, na)}</td>
                  <td className="num">{money(p.roi.costPerTaskUsd, na)}</td>
                  <td className="num dim">{money(p.roi.costPerAgentHourUsd, na)}</td>
                  <td className="num dim">
                    {p.roi.agentMsPerTask == null ? na : f.durationPrecise(p.roi.agentMsPerTask)}
                  </td>
                  <td className="num dim">
                    {fmtCompact((p.tokens.input ?? 0) + (p.tokens.output ?? 0))}
                  </td>
                  <td>
                    <span className={`badge ${p.roi.costBasis === 'measured' ? 'measured' : 'est'}`}>
                      {basisLabel(t, p.roi.costBasis)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {data.unpricedModels.length > 0 && (
        <div className="note warn">
          {t('cost.unpriced', { models: data.unpricedModels.join(', ') })}
        </div>
      )}

      <Panel title={t('cost.method')}>
        <ul className="dim" style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 5 }}>
          <li>{t('cost.methodMeasured')}</li>
          <li>{t('cost.methodEstimated', { asOf: data.ratesAsOf })}</li>
          <li>{t('cost.methodOverride')}</li>
          {!data.usingListPrices && (
            <li>
              <strong>{t('cost.methodCustom')}</strong>
            </li>
          )}
        </ul>

        {data.appliedRates.length > 0 && (
          <div className="scroll-x" style={{ marginTop: 12 }}>
            <table className="grid" style={{ maxWidth: 680 }}>
              <thead>
                <tr>
                  <th>{t('cost.appliedRates')}</th>
                  <th className="num">{t('cost.colInputRate')}</th>
                  <th className="num">{t('cost.colOutputRate')}</th>
                  <th className="num">{t('cost.colCacheReadRate')}</th>
                  <th className="num">{t('cost.colCacheWriteRate')}</th>
                </tr>
              </thead>
              <tbody>
                {data.appliedRates.map(({ model, rate }) => (
                  <tr key={model}>
                    <td className="mono truncate">{model}</td>
                    <td className="num dim">{rate.input.toFixed(2)}</td>
                    <td className="num dim">{rate.output.toFixed(2)}</td>
                    <td className="num dim">{rate.cacheRead.toFixed(3)}</td>
                    <td className="num dim">{rate.cacheWrite.toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

/**
 * Daily spend, split by how each dollar was arrived at.
 *
 * The hatched part of a bar is estimated. Keeping it inside the same column
 * rather than in a second chart is deliberate: the day's total is what gets
 * budgeted, and how much of it is a guess has to be visible in the same glance.
 */
function SpendBars({ daily }: { daily: DailyCost[] }): React.ReactElement {
  const { t } = useI18n();
  const f = useFormat();
  const [hover, setHover] = useState<{ x: number; y: number; day: DailyCost } | null>(null);

  const max = Math.max(...daily.map((d) => d.measuredUsd + d.estimatedUsd), 0);
  if (max <= 0) return <div className="empty">{t('cost.trendEmpty')}</div>;

  return (
    <div>
      <div className="bars" onMouseLeave={() => setHover(null)}>
        {daily.map((d) => {
          const total = d.measuredUsd + d.estimatedUsd;
          return (
            <div
              key={d.dayKey}
              className="bar-col"
              onMouseMove={(e) => setHover({ x: e.clientX + 12, y: e.clientY + 14, day: d })}
            >
              <div className="bar-stack" style={{ height: `${(total / max) * 100}%` }}>
                {d.measuredUsd > 0 && (
                  <div
                    className="bar-seg measured"
                    style={{ height: `${(d.measuredUsd / total) * 100}%` }}
                  />
                )}
                {d.estimatedUsd > 0 && (
                  <div
                    className="bar-seg estimated"
                    style={{ height: `${(d.estimatedUsd / total) * 100}%` }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="bar-labels">
        {daily.map((d) => (
          <div key={d.dayKey} title={d.dayKey}>
            {daily.length <= 10 ? f.weekday(d.dayKey) : d.dayKey.slice(8)}
          </div>
        ))}
      </div>

      {hover && (
        <div className="tooltip" style={{ left: hover.x, top: hover.y }}>
          <div className="t-title">
            {hover.day.dayKey} · {f.weekday(hover.day.dayKey)}
          </div>
          <div className="dim">
            {t('cost.legendMeasured')} <strong>{fmtCost(hover.day.measuredUsd)}</strong>
          </div>
          <div className="dim">
            {t('cost.legendEstimated')} <strong>{fmtCost(hover.day.estimatedUsd)}</strong>
          </div>
          <div className="faint">
            {t('cost.colTasks')} {hover.day.tasks} ·{' '}
            {hover.day.costPerTaskUsd == null
              ? t('common.na')
              : `${fmtCost(hover.day.costPerTaskUsd)} / ${t('cost.colTasks').toLowerCase()}`}
          </div>
        </div>
      )}
    </div>
  );
}

function ModelTable({ models }: { models: ModelRollup[] }): React.ReactElement {
  const { t } = useI18n();
  const na = t('common.na');
  const total = models.reduce((sum, m) => sum + m.measuredUsd + m.estimatedUsd, 0);

  return (
    <div className="scroll-x">
      <table className="grid fixed" style={{ minWidth: 900 }}>
        <thead>
          <tr>
            <th>{t('cost.colModel')}</th>
            <th style={{ width: 130 }}>{t('cost.colShare')}</th>
            <th className="num" style={{ width: 96 }}>
              {t('cost.colCost')}
            </th>
            <th className="num" style={{ width: 90 }}>
              {t('cost.colInput')}
            </th>
            <th className="num" style={{ width: 90 }}>
              {t('cost.colOutput')}
            </th>
            <th className="num" style={{ width: 100 }}>
              {t('cost.colCacheRead')}
            </th>
            <th style={{ width: 104 }}>{t('cost.colBasis')}</th>
          </tr>
        </thead>
        <tbody>
          {models.map((m) => {
            const spend = m.measuredUsd + m.estimatedUsd;
            const share = total > 0 ? spend / total : 0;
            return (
              <tr key={m.model} className={`row-${m.provider}`}>
                <td className="mono truncate" title={m.model}>
                  {m.model}
                </td>
                <td>
                  <div className="meter" title={`${(share * 100).toFixed(1)}%`}>
                    {m.measuredUsd > 0 && (
                      <i
                        className="measured"
                        style={{ width: `${(m.measuredUsd / (total || 1)) * 100}%` }}
                      />
                    )}
                    {m.estimatedUsd > 0 && (
                      <i
                        className="estimated"
                        style={{ width: `${(m.estimatedUsd / (total || 1)) * 100}%` }}
                      />
                    )}
                  </div>
                </td>
                <td className="num">{m.basis === 'unpriced' ? na : fmtCost(spend)}</td>
                <td className="num dim">{fmtCompact(m.tokens.input ?? 0)}</td>
                <td className="num dim">{fmtCompact(m.tokens.output ?? 0)}</td>
                <td className="num faint">{fmtCompact(m.tokens.cacheRead ?? 0)}</td>
                <td>
                  <span
                    className={`badge ${
                      m.basis === 'measured' ? 'measured' : m.basis === 'unpriced' ? '' : 'est'
                    }`}
                  >
                    {basisLabel(t, m.basis)}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
