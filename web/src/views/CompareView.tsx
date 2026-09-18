import type { ProviderComparison } from '@api/api';
import { useEffect, useState } from 'react';

import { Panel } from '../components/Tiles';
import { api } from '../lib/api';
import { fmtCompact, fmtCost, tokenTotal, useFormat } from '../lib/format';
import { useI18n, type MessageKey } from '../lib/i18n';

/**
 * Provider comparison.
 *
 * The "does not record" section is the honest part of this screen: a metric a
 * provider never writes down shows as "not recorded", never as zero, so Codex
 * does not look free just because it does not report cost.
 */

/**
 * The server sends its limitation list in English; the UI maps it onto
 * translated strings so the page reads in one language. Anything unmapped falls
 * through verbatim rather than disappearing.
 */
const LIMIT_KEYS: Record<string, MessageKey> = {
  'cost in USD': 'compare.limit.codex.cost',
  'per-session runtime marker (liveness is inferred from log recency)':
    'compare.limit.codex.marker',
  'per-turn time-to-first-token': 'compare.limit.claude.ttft',
};

export function CompareView({
  days,
  refreshToken,
}: {
  days: number;
  refreshToken: number;
}): React.ReactElement {
  const { t } = useI18n();
  const f = useFormat();
  const [rows, setRows] = useState<ProviderComparison[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .comparison(days)
      .then((r) => !cancelled && setRows(r))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [days, refreshToken]);

  if (error) return <div className="note warn">{t('compare.loadFailed', { error })}</div>;
  if (!rows) return <div className="empty">{t('common.loading')}</div>;

  const metric = (
    label: string,
    render: (r: ProviderComparison) => React.ReactNode,
    hint?: string,
  ): React.ReactElement => (
    <tr key={label}>
      <td title={hint}>{label}</td>
      {rows.map((r) => (
        <td key={r.provider} className="num">
          {render(r)}
        </td>
      ))}
    </tr>
  );

  const notRecorded = <span className="faint">{t('common.notRecorded')}</span>;

  return (
    <>
      <Panel title={t('compare.title', { n: days })} flush>
        <table className="grid">
          <thead>
            <tr>
              <th>{t('compare.metric')}</th>
              {rows.map((r) => (
                <th key={r.provider} className="num">
                  <span className={`badge ${r.provider}`}>{r.displayName}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {metric(t('compare.sessions'), (r) => r.sessionCount)}
            {metric(
              t('compare.agentTime'),
              (r) => f.duration(r.agentActiveMs),
              t('compare.agentTimeTitle'),
            )}
            {metric(
              t('compare.clockTime'),
              (r) => f.duration(r.clockActiveMs),
              t('compare.clockTimeTitle'),
            )}
            {metric(t('compare.prompts'), (r) => r.userPrompts)}
            {metric(t('compare.toolCalls'), (r) => fmtCompact(r.toolCalls))}
            {metric(t('compare.tokens'), (r) => fmtCompact(tokenTotal(r.tokens)))}
            {metric(t('compare.cacheRead'), (r) => fmtCompact(r.tokens.cacheRead ?? 0))}
            {metric(
              t('compare.apiTime'),
              (r) => (r.measuredApiMs === undefined ? notRecorded : f.duration(r.measuredApiMs)),
              t('compare.apiTimeTitle'),
            )}
            {metric(t('compare.toolTime'), (r) =>
              r.measuredToolMs === undefined ? notRecorded : f.duration(r.measuredToolMs),
            )}
            {metric(t('compare.cost'), (r) =>
              r.costUsd === undefined ? notRecorded : fmtCost(r.costUsd),
            )}
          </tbody>
        </table>
      </Panel>

      <Panel title={t('compare.unavailable')}>
        <div className="split">
          {rows.map((r) => (
            <div key={r.provider}>
              <div style={{ marginBottom: 6 }}>
                <span className={`badge ${r.provider}`}>{r.displayName}</span>
              </div>
              <ul className="dim" style={{ margin: 0, paddingLeft: 18 }}>
                {r.unavailable.map((u) => (
                  <li key={u}>{LIMIT_KEYS[u] ? t(LIMIT_KEYS[u]) : u}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Panel>

      <div className="note">{t('compare.note')}</div>
    </>
  );
}
