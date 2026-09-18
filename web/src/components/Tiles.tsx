import type React from 'react';

import { useI18n } from '../lib/i18n';

/**
 * Stat tiles.
 *
 * `kind` is not decoration: it says whether the number is something a provider
 * measured and wrote down, or something this app estimated from event
 * timestamps. Users make scheduling and billing decisions from these numbers,
 * so the distinction is always visible, never a footnote.
 */
export type StatKind = 'measured' | 'estimate' | 'fact';

export interface StatProps {
  label: string;
  value: string;
  sub?: string;
  kind?: StatKind;
  title?: string;
}

export function Stat({ label, value, sub, kind = 'fact', title }: StatProps): React.ReactElement {
  const { t } = useI18n();
  return (
    <div className={`tile ${kind}`} title={title}>
      <div className="label">
        {label}
        {kind === 'estimate' && <span className="badge est">{t('common.est')}</span>}
        {kind === 'measured' && <span className="badge measured">{t('common.measured')}</span>}
      </div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

export function Tiles({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="tiles">{children}</div>;
}

export function Panel({
  title,
  actions,
  children,
  flush,
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  flush?: boolean;
}): React.ReactElement {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{title}</h2>
        {actions && <div className="spacer" />}
        {actions}
      </div>
      <div className={`panel-body${flush ? ' flush' : ''}`}>{children}</div>
    </section>
  );
}
