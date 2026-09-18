import type { SessionLane } from '@api/api';
import { useMemo, useRef, useState } from 'react';

import { fmtClock, PROVIDER_LABEL, useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';

/**
 * Day timeline.
 *
 * One lane per non-overlapping group of sessions, drawn as:
 *   - a faint bar for the session's WALL SPAN (first event -> last event), and
 *   - solid blocks for its ACTIVE SEGMENTS.
 *
 * Showing both in one row is the point: the gap between the faint bar and the
 * solid blocks is exactly the idle time, so "a 3 hour session" cannot be
 * mistaken for "3 hours of agent work" just by looking at it.
 *
 * Below the lanes sits the concurrency strip: how many sessions were active at
 * each moment, as a step area.
 */

const LANE_H = 22;
const LANE_GAP = 3;
const AXIS_H = 18;
const CONC_H = 52;
const LEFT = 0;

export interface TimelineProps {
  dayStart: number;
  dayEnd: number;
  sessions: SessionLane[];
  concurrencySteps: Array<{ ts: number; count: number }>;
  selectedKey?: string | null;
  onSelect?: (key: string) => void;
  now?: number;
}

interface TooltipState {
  x: number;
  y: number;
  title: string;
  lines: string[];
}

export function Timeline(props: TimelineProps): React.ReactElement {
  const { dayStart, dayEnd, sessions, concurrencySteps } = props;
  const { t } = useI18n();
  const f = useFormat();
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const laneCount = useMemo(
    () => Math.max(1, sessions.reduce((max, s) => Math.max(max, s.lane + 1), 0)),
    [sessions],
  );

  const width = 1000; // viewBox units; the SVG scales to its container
  const lanesH = laneCount * (LANE_H + LANE_GAP);
  const height = AXIS_H + lanesH + CONC_H + 8;
  const span = Math.max(1, dayEnd - dayStart);

  const x = (ts: number): number => LEFT + ((ts - dayStart) / span) * (width - LEFT);

  const hours = useMemo(() => {
    const out: Array<{ ts: number; label: string }> = [];
    const total = Math.round((dayEnd - dayStart) / 3_600_000);
    for (let h = 0; h <= total; h += 1) {
      const ts = dayStart + h * 3_600_000;
      out.push({ ts, label: h % 3 === 0 ? fmtClock(ts) : '' });
    }
    return out;
  }, [dayStart, dayEnd]);

  const maxConc = useMemo(
    () => Math.max(1, ...concurrencySteps.map((s) => s.count)),
    [concurrencySteps],
  );

  /** Step area path for the concurrency strip. */
  const concPath = useMemo(() => {
    if (concurrencySteps.length === 0) return '';
    const px = (ts: number): number => LEFT + ((ts - dayStart) / span) * (width - LEFT);
    const baseY = AXIS_H + lanesH + CONC_H;
    const scale = (c: number): number => baseY - (c / maxConc) * (CONC_H - 6);

    let d = `M ${px(dayStart)} ${baseY}`;
    let prevY = baseY;
    for (const step of concurrencySteps) {
      const at = px(Math.max(dayStart, Math.min(dayEnd, step.ts)));
      d += ` L ${at} ${prevY}`;
      prevY = scale(step.count);
      d += ` L ${at} ${prevY}`;
    }
    d += ` L ${px(dayEnd)} ${prevY} L ${px(dayEnd)} ${baseY} Z`;
    return d;
  }, [concurrencySteps, maxConc, lanesH, dayStart, dayEnd, span]);

  const showTip = (e: React.MouseEvent, title: string, lines: string[]): void => {
    setTooltip({ x: e.clientX + 12, y: e.clientY + 14, title, lines });
  };

  return (
    <div style={{ position: 'relative' }}>
      <svg
        ref={svgRef}
        className="timeline"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        style={{ height }}
        role="img"
        aria-label="Session activity timeline"
        onMouseLeave={() => setTooltip(null)}
      >
        {/* hour grid */}
        {hours.map((h) => (
          <g key={h.ts}>
            <line className="grid-line" x1={x(h.ts)} y1={AXIS_H - 4} x2={x(h.ts)} y2={height} />
            {h.label && (
              <text className="hour-label" x={x(h.ts) + 3} y={10}>
                {h.label}
              </text>
            )}
          </g>
        ))}

        {/* lanes */}
        {Array.from({ length: laneCount }, (_, i) => (
          <rect
            key={`lane-${i}`}
            className="lane-bg"
            x={LEFT}
            y={AXIS_H + i * (LANE_H + LANE_GAP)}
            width={width - LEFT}
            height={LANE_H}
            rx={2}
          />
        ))}

        {sessions.map((s) => {
          const y = AXIS_H + s.lane * (LANE_H + LANE_GAP);
          const selected = props.selectedKey === s.key;
          const wall = s.dayWallSpan;
          const tipLines = [
            `${PROVIDER_LABEL[s.provider]} · ${s.host.label}`,
            `${t('day.legendWall')} ${fmtClock(s.startedAt)}–${fmtClock(s.endedAt)} (${f.duration(s.wallSpanMs)})`,
            `${t('table.active')} ${f.duration(s.activity.activeMs)} · ${t('table.idle')} ${f.duration(s.activity.idleMs)}`,
            `${t('table.prompts')} ${s.counters.userPrompts} · ${t('table.tools')} ${s.counters.toolCalls}`,
          ];
          return (
            <g
              key={s.key}
              onClick={() => props.onSelect?.(s.key)}
              onMouseMove={(e) => showTip(e, s.title ?? s.sessionId, tipLines)}
              style={{ cursor: 'pointer' }}
            >
              {wall && (
                <rect
                  className="wall"
                  x={x(wall.start)}
                  y={y + LANE_H / 2 - 2}
                  width={Math.max(1, x(wall.end) - x(wall.start))}
                  height={4}
                  rx={2}
                />
              )}
              {s.daySegments.map((seg, i) => (
                <rect
                  key={i}
                  className={`seg ${s.provider}`}
                  x={x(seg.start)}
                  y={y + 3}
                  width={Math.max(1.5, x(seg.end) - x(seg.start))}
                  height={LANE_H - 6}
                  rx={2}
                />
              ))}
              {selected && wall && (
                <rect
                  className="sel"
                  x={x(wall.start) - 1}
                  y={y + 1}
                  width={Math.max(3, x(wall.end) - x(wall.start)) + 2}
                  height={LANE_H - 2}
                  rx={3}
                />
              )}
            </g>
          );
        })}

        {/* concurrency strip */}
        {concPath && <path className="conc-area" d={concPath} />}
        {/* Anchored right: activity usually starts at the left, and a label
            sitting on top of the very data it describes is worse than none. */}
        <text
          className="hour-label"
          x={width - 4}
          y={AXIS_H + lanesH + 12}
          textAnchor="end"
        >
          {t('day.peak')}: {maxConc}
        </text>

        {props.now !== undefined && props.now >= dayStart && props.now <= dayEnd && (
          <line className="now-line" x1={x(props.now)} y1={AXIS_H - 4} x2={x(props.now)} y2={height} />
        )}
      </svg>

      {tooltip && (
        <div className="tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          <div className="t-title">{tooltip.title}</div>
          {tooltip.lines.map((line, i) => (
            <div key={i} className="dim">
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
