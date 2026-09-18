import type { SessionSummary } from '@core/types';

import {
  fmtClock,
  fmtCompact,
  fmtCost,
  PROVIDER_LABEL,
  shortPath,
  tokenTotal,
  useFormat,
} from '../lib/format';
import { useI18n, type MessageKey } from '../lib/i18n';

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
  const { t } = useI18n();
  const f = useFormat();

  if (sessions.length === 0) {
    return <div className="empty">{t('table.empty')}</div>;
  }

  return (
    <div className="scroll-x">
      <table className="grid fixed" style={{ minWidth: 1100 }}>
        <thead>
          <tr>
            <th style={{ width: 26 }} />
            <th>{t('table.session')}</th>
            <th style={{ width: 110 }}>{t('table.provider')}</th>
            <th style={{ width: 100 }}>{t('table.host')}</th>
            <th className="num" style={{ width: 62 }}>
              {t('table.start')}
            </th>
            <th className="num" style={{ width: 62 }}>
              {t('table.end')}
            </th>
            <th className="num" style={{ width: 78 }} title={t('table.wallTitle')}>
              {t('table.wall')}
            </th>
            <th className="num" style={{ width: 100 }} title={t('table.activeTitle')}>
              {t('table.active')}
            </th>
            <th className="num" style={{ width: 82 }}>
              {t('table.idle')}
            </th>
            <th className="num" style={{ width: 78 }}>
              {t('table.prompts')}
            </th>
            <th className="num" style={{ width: 66 }}>
              {t('table.tools')}
            </th>
            <th className="num" style={{ width: 80 }} title={t('table.tokensTitle')}>
              {t('table.tokens')}
            </th>
            <th className="num" style={{ width: 82 }} title={t('table.costTitle')}>
              {t('table.cost')}
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
                selectedKey === s.key
                  ? { outline: '1px solid var(--accent)', outlineOffset: -1 }
                  : undefined
              }
            >
              <td
                title={`${t(`live.${s.live.status}` as MessageKey)} · ${t('overview.confidence', {
                  level: t(`live.${s.live.confidence}` as MessageKey),
                })}`}
              >
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
                {showDate && (
                  <span className="faint">
                    {new Date(s.startedAt).toLocaleDateString(f.locale)}{' '}
                  </span>
                )}
                {fmtClock(s.startedAt)}
              </td>
              <td className="num">{fmtClock(s.endedAt)}</td>
              <td className="num dim">{f.duration(s.wallSpanMs)}</td>
              <td className="num">{f.duration(s.activity.activeMs)}</td>
              <td className="num faint">{f.duration(s.activity.idleMs)}</td>
              <td className="num">{s.counters.userPrompts}</td>
              <td className="num">{s.counters.toolCalls}</td>
              <td className="num dim">{fmtCompact(tokenTotal(s.tokens))}</td>
              <td className="num dim">{s.costUsd == null ? t('common.na') : fmtCost(s.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
