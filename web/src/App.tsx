import type { StatusResponse } from '@api/api';
import type { ProviderId } from '@core/types';
import { useCallback, useEffect, useState } from 'react';

import {
  BrandMark,
  IconCompare,
  IconCost,
  IconDaily,
  IconOverview,
  IconPower,
  IconSources,
} from './components/icons';
import { api, subscribe } from './lib/api';
import { todayKey } from './lib/format';
import { useI18n, type Lang, type MessageKey } from './lib/i18n';
import { CompareView } from './views/CompareView';
import { CostView } from './views/CostView';
import { DayView } from './views/DayView';
import { Overview } from './views/Overview';
import { SessionView } from './views/SessionView';
import { SourcesView } from './views/SourcesView';

type Tab = 'overview' | 'day' | 'cost' | 'compare' | 'sources';

interface TabDef {
  id: Tab;
  label: MessageKey;
  Icon: () => React.ReactElement;
  /** Views that summarise a range of days and take the range control. */
  ranged: boolean;
  /** Views that can be narrowed to one provider. */
  filterable: boolean;
}

const TABS: TabDef[] = [
  { id: 'overview', label: 'nav.overview', Icon: IconOverview, ranged: true, filterable: true },
  { id: 'day', label: 'nav.daily', Icon: IconDaily, ranged: false, filterable: true },
  { id: 'cost', label: 'nav.cost', Icon: IconCost, ranged: true, filterable: true },
  { id: 'compare', label: 'nav.compare', Icon: IconCompare, ranged: true, filterable: false },
  { id: 'sources', label: 'nav.sources', Icon: IconSources, ranged: false, filterable: false },
];

export function App(): React.ReactElement {
  const { t, lang, setLang } = useI18n();
  const [tab, setTab] = useState<Tab>('overview');
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [provider, setProvider] = useState<ProviderId | 'all'>('all');
  const [days, setDays] = useState(7);
  const [dayKey, setDayKey] = useState(todayKey());
  const [sessionKey, setSessionKey] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [quit, setQuit] = useState(false);

  const refresh = useCallback(() => setRefreshToken((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    const load = (): void => {
      api
        .status()
        .then((s) => alive && setStatus(s))
        .catch(() => undefined);
    };
    load();
    // The SSE stream carries scan progress; `status` is re-fetched when a scan
    // completes so roots, warnings and config stay in sync without polling.
    const unsubscribe = subscribe((type, data) => {
      if (!alive) return;
      if (type === 'hello') setStatus(data as StatusResponse);
      if (type === 'progress') {
        setStatus((prev) => (prev ? { ...prev, progress: data as StatusResponse['progress'] } : prev));
      }
      if (type === 'scan') {
        load();
        refresh();
      }
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [refresh]);

  const scanning = status?.scanning ?? false;
  const progress = status?.progress ?? null;
  const pct =
    progress && progress.filesTotal > 0
      ? Math.round((progress.filesDone / progress.filesTotal) * 100)
      : null;

  const openSession = (key: string): void => {
    setSessionKey(key);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // The packaged app has no console, so quitting has to be possible from here.
  const onQuit = (): void => {
    if (!window.confirm(t('shell.quitConfirm'))) return;
    setQuit(true);
    void api.quit();
  };

  if (quit) {
    return (
      <div className="app" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
        <main className="main">
          <div className="empty" style={{ paddingTop: 80 }}>
            {t('shell.quitDone')}
          </div>
        </main>
      </div>
    );
  }

  const current = TABS.find((x) => x.id === tab) ?? TABS[0]!;
  const subtitle = sessionKey
    ? t('nav.sessionSub')
    : current.ranged
      ? t('shell.rangeSub', { n: days })
      : current.id === 'day'
        ? dayKey
        : (status?.timezone ?? '');

  return (
    <div className="app">
      <aside className="rail">
        <div className="rail-mark" title={`Agent Session Observer v${status?.version ?? '—'}`}>
          <BrandMark />
        </div>

        <nav className="rail-nav">
          {TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              aria-current={tab === id && !sessionKey}
              title={t(label)}
              onClick={() => {
                setTab(id);
                setSessionKey(null);
              }}
            >
              <Icon />
              {t(label)}
            </button>
          ))}
        </nav>

        <div className="rail-foot">
          <div className="seg stack compact" title={t('shell.language')}>
            {(['en', 'ja'] as Lang[]).map((l) => (
              <button key={l} aria-pressed={lang === l} onClick={() => setLang(l)}>
                {l === 'en' ? 'EN' : '日本語'}
              </button>
            ))}
          </div>

          {status?.canQuit && (
            <button className="btn icon" onClick={onQuit} title={t('shell.quitTitle')}>
              <IconPower />
            </button>
          )}
        </div>
      </aside>

      <div className="frame">
        <header className="topbar">
          <div className="view-title">
            {sessionKey ? t('nav.session') : t(current.label)}
            <small>{subtitle}</small>
          </div>

          {current.ranged && !sessionKey && (
            <div className="seg">
              {[1, 7, 14, 30].map((d) => (
                <button key={d} aria-pressed={days === d} onClick={() => setDays(d)}>
                  {t('common.days', { n: d })}
                </button>
              ))}
            </div>
          )}

          {current.filterable && !sessionKey && (
            <div className="seg">
              {(
                [
                  ['all', 'common.all'],
                  ['codex', 'common.codex'],
                  ['claude-code', 'common.claudeCode'],
                ] as Array<[ProviderId | 'all', MessageKey]>
              ).map(([id, key]) => (
                <button key={id} aria-pressed={provider === id} onClick={() => setProvider(id)}>
                  {t(key)}
                </button>
              ))}
            </div>
          )}

          <div className="topbar-right">
            <span className="privacy-banner" title={t('shell.localOnlyTitle')}>
              🔒 {t('shell.localOnly')}
            </span>

            {scanning ? (
              <span className="dim">
                <span className="spin" />{' '}
                {t('shell.scanning', {
                  done: progress?.filesDone ?? 0,
                  total: progress?.filesTotal ?? 0,
                })}
              </span>
            ) : (
              <span className="dim">
                {t('shell.sessions', { n: status?.sessionCount ?? 0 })} · {status?.timezone ?? ''}
              </span>
            )}

            <button
              className="btn"
              onClick={() => {
                void api.rescan();
              }}
              disabled={scanning}
            >
              {t('shell.rescan')}
            </button>
          </div>
        </header>

        {/* Measurement scale and scan progress in one strip. */}
        <div className="rule">{scanning && pct !== null && <i style={{ width: `${pct}%` }} />}</div>

        <main className="main">
          {status && status.roots.length === 0 && !scanning && (
            <div className="note warn">{t('shell.noRoots')}</div>
          )}

          {sessionKey ? (
            <SessionView sessionKey={sessionKey} onBack={() => setSessionKey(null)} />
          ) : tab === 'overview' ? (
            <Overview
              days={days}
              provider={provider}
              refreshToken={refreshToken}
              onPickDay={(d) => {
                setDayKey(d);
                setTab('day');
              }}
              onPickSession={openSession}
            />
          ) : tab === 'day' ? (
            <DayView
              dayKey={dayKey}
              provider={provider}
              refreshToken={refreshToken}
              onChangeDay={setDayKey}
              onPickSession={openSession}
            />
          ) : tab === 'cost' ? (
            <CostView days={days} provider={provider} refreshToken={refreshToken} />
          ) : tab === 'compare' ? (
            <CompareView days={days} refreshToken={refreshToken} />
          ) : (
            <SourcesView status={status} onConfigSaved={refresh} />
          )}
        </main>
      </div>
    </div>
  );
}
