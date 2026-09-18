import type { DailySummary } from '@core/aggregate';
import { useState } from 'react';

import { PROVIDER_LABEL, useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';

/**
 * Daily agent-time bars, stacked by provider, with a dashed marker for
 * clock-active time.
 *
 * The two are different quantities and the chart says so: the stack height is
 * summed agent time (three agents for an hour = three hours), the dashed line
 * is wall-clock time with at least one agent working (the same case = one
 * hour). When the dash sits well below the stack, work was parallel.
 */
export function DailyBars({
  days,
  selected,
  onSelect,
}: {
  days: DailySummary[];
  selected?: string;
  onSelect?: (dayKey: string) => void;
}): React.ReactElement {
  const { t } = useI18n();
  const f = useFormat();
  const [hover, setHover] = useState<{ x: number; y: number; day: DailySummary } | null>(null);
  const max = Math.max(1, ...days.map((d) => Math.max(d.agentActiveMs, d.clockActiveMs)));

  return (
    <div>
      <div className="bars" onMouseLeave={() => setHover(null)}>
        {days.map((d) => {
          const stack = d.byProvider.length > 0 ? d.byProvider : [];
          const totalH = (d.agentActiveMs / max) * 100;
          return (
            <div
              key={d.dayKey}
              className="bar-col"
              onClick={() => onSelect?.(d.dayKey)}
              onMouseMove={(e) => setHover({ x: e.clientX + 12, y: e.clientY + 14, day: d })}
              style={{ opacity: selected && selected !== d.dayKey ? 0.55 : 1 }}
            >
              <div className="bar-stack" style={{ height: `${totalH}%` }}>
                {stack.map((p) => (
                  <div
                    key={p.provider}
                    className={`bar-seg ${p.provider}`}
                    style={{
                      height: `${d.agentActiveMs > 0 ? (p.agentActiveMs / d.agentActiveMs) * 100 : 0}%`,
                    }}
                  />
                ))}
              </div>
              {d.clockActiveMs > 0 && (
                <div className="bar-clock" style={{ bottom: `${(d.clockActiveMs / max) * 100}%` }} />
              )}
            </div>
          );
        })}
      </div>
      <div className="bar-labels">
        {days.map((d) => (
          <div key={d.dayKey} title={d.dayKey}>
            {days.length <= 10 ? f.weekday(d.dayKey) : d.dayKey.slice(8)}
          </div>
        ))}
      </div>

      {hover && (
        <div className="tooltip" style={{ left: hover.x, top: hover.y }}>
          <div className="t-title">
            {hover.day.dayKey} · {f.weekday(hover.day.dayKey)}
          </div>
          <div className="dim">
            {t('day.agentTime')} <strong>{f.duration(hover.day.agentActiveMs)}</strong>
          </div>
          <div className="dim">
            {t('overview.legendClock')} <strong>{f.duration(hover.day.clockActiveMs)}</strong>
          </div>
          <div className="dim">
            {t('shell.sessions', { n: hover.day.sessionCount })} · {t('day.peak')}{' '}
            {hover.day.peakConcurrency}
          </div>
          {hover.day.byProvider.map((p) => (
            <div key={p.provider} className="faint">
              {PROVIDER_LABEL[p.provider]}: {f.duration(p.agentActiveMs)} ({p.sessionCount})
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
