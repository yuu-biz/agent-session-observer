import type { StatusResponse } from '@api/api';
import type { ProviderId } from '@core/types';
import { useCallback, useEffect, useState } from 'react';

import { api, subscribe } from './lib/api';
import { todayKey } from './lib/format';
import { useI18n, type Lang, type MessageKey } from './lib/i18n';
import { CompareView } from './views/CompareView';
import { DayView } from './views/DayView';
import { Overview } from './views/Overview';
import { SessionView } from './views/SessionView';
import { SourcesView } from './views/SourcesView';

type Tab = 'overview' | 'day' | 'compare' | 'sources';

const TABS: Array<[Tab, MessageKey]> = [
  ['overview', 'nav.overview'],
  ['day', 'nav.daily'],
  ['compare', 'nav.compare'],
  ['sources', 'nav.sources'],
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
      <div className="app">
        <main className="main">
          <div className="empty" style={{ paddingTop: 80 }}>
            {t('shell.quitDone')}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Agent Session Observer
          <span>v{status?.version ?? '—'}</span>
        </div>

        <nav className="nav">
          {TABS.map(([id, key]) => (
            <button
              key={id}
              aria-current={tab === id && !sessionKey}
              onClick={() => {
                setTab(id);
                setSessionKey(null);
              }}
            >
              {t(key)}
            </button>
          ))}
        </nav>

        {(tab === 'overview' || tab === 'compare') && !sessionKey && (
          <div className="seg">
            {[1, 7, 14, 30].map((d) => (
              <button key={d} aria-pressed={days === d} onClick={() => setDays(d)}>
                {t('common.days', { n: d })}
              </button>
            ))}
          </div>
        )}

        {tab !== 'compare' && tab !== 'sources' && !sessionKey && (
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

          <div className="seg" title={t('shell.language')}>
            {(['en', 'ja'] as Lang[]).map((l) => (
              <button key={l} aria-pressed={lang === l} onClick={() => setLang(l)}>
                {l === 'en' ? 'EN' : '日本語'}
              </button>
            ))}
          </div>

          <button
            className="btn"
            onClick={() => {
              void api.rescan();
            }}
            disabled={scanning}
          >
            {t('shell.rescan')}
          </button>

          {status?.canQuit && (
            <button className="btn" onClick={onQuit} title={t('shell.quitTitle')}>
              {t('shell.quit')}
            </button>
          )}
        </div>
      </header>

      {scanning && pct !== null && (
        <div className="progress">
          <i style={{ width: `${pct}%` }} />
        </div>
      )}

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
        ) : tab === 'compare' ? (
          <CompareView days={days} refreshToken={refreshToken} />
        ) : (
          <SourcesView status={status} onConfigSaved={refresh} />
        )}
      </main>
    </div>
  );
}
