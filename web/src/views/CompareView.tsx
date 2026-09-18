import type { ProviderComparison } from '@api/api';
import { useEffect, useState } from 'react';

import { Panel } from '../components/Tiles';
import { api } from '../lib/api';
import { fmtCompact, fmtCost, fmtDuration, tokenTotal } from '../lib/format';

/**
 * Provider comparison.
 *
 * The `unavailable` column is the honest part of this screen: a metric a
 * provider never writes down shows as "not recorded", never as zero, so Codex
 * does not look free just because it does not report cost.
 */
export function CompareView({
  days,
  refreshToken,
}: {
  days: number;
  refreshToken: number;
}): React.ReactElement {
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

  if (error) return <div className="note warn">Failed to load comparison: {error}</div>;
  if (!rows) return <div className="empty">Loading…</div>;

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

  return (
    <>
      <Panel title={`Codex vs Claude Code — last ${days} days`} flush>
        <table className="grid">
          <thead>
            <tr>
              <th>Metric</th>
              {rows.map((r) => (
                <th key={r.provider} className="num">
                  <span className={`badge ${r.provider}`}>{r.displayName}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {metric('Sessions', (r) => r.sessionCount)}
            {metric(
              'Agent time (sum, est.)',
              (r) => fmtDuration(r.agentActiveMs),
              'Sum of this provider’s active segments.',
            )}
            {metric(
              'Clock time (est.)',
              (r) => fmtDuration(r.clockActiveMs),
              'Wall-clock time with at least one session of this provider active.',
            )}
            {metric('User prompts', (r) => r.userPrompts)}
            {metric('Tool calls', (r) => fmtCompact(r.toolCalls))}
            {metric('Tokens (in+out)', (r) => fmtCompact(tokenTotal(r.tokens)))}
            {metric('Cache read tokens', (r) => fmtCompact(r.tokens.cacheRead ?? 0))}
            {metric(
              'API time (measured)',
              (r) => (r.measuredApiMs === undefined ? <span className="faint">not recorded</span> : fmtDuration(r.measuredApiMs)),
              'Reported by the provider itself, not estimated.',
            )}
            {metric(
              'Tool time (measured)',
              (r) => (r.measuredToolMs === undefined ? <span className="faint">not recorded</span> : fmtDuration(r.measuredToolMs)),
            )}
            {metric('Cost (measured)', (r) =>
              r.costUsd === undefined ? <span className="faint">not recorded</span> : fmtCost(r.costUsd),
            )}
          </tbody>
        </table>
      </Panel>

      <Panel title="What each provider does not record">
        <div className="split">
          {rows.map((r) => (
            <div key={r.provider}>
              <div style={{ marginBottom: 6 }}>
                <span className={`badge ${r.provider}`}>{r.displayName}</span>
              </div>
              <ul className="dim" style={{ margin: 0, paddingLeft: 18 }}>
                {r.unavailable.map((u) => (
                  <li key={u}>{u}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Panel>

      <div className="note">
        Totals are not directly comparable as a measure of “which agent works harder”: the two CLIs
        log at different granularities, and active time is estimated from event density. Treat this
        as a view of your own usage mix, not a benchmark.
      </div>
    </>
  );
}
