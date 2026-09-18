import type { StatusResponse } from '@api/api';
import type { ProviderId } from '@core/types';
import { useCallback, useEffect, useState } from 'react';

import { api, subscribe } from './lib/api';
import { todayKey } from './lib/format';
import { CompareView } from './views/CompareView';
import { DayView } from './views/DayView';
import { Overview } from './views/Overview';
import { SessionView } from './views/SessionView';
import { SourcesView } from './views/SourcesView';

type Tab = 'overview' | 'day' | 'compare' | 'sources';

export function App(): React.ReactElement {
  const [tab, setTab] = useState<Tab>('overview');
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [provider, setProvider] = useState<ProviderId | 'all'>('all');
  const [days, setDays] = useState(7);
  const [dayKey, setDayKey] = useState(todayKey());
  const [sessionKey, setSessionKey] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

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

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Agent Session Observer
          <span>v{status?.version ?? '—'}</span>
        </div>

        <nav className="nav">
          {(
            [
              ['overview', 'Overview'],
              ['day', 'Daily'],
              ['compare', 'Compare'],
              ['sources', 'Sources'],
            ] as Array<[Tab, string]>
          ).map(([id, label]) => (
            <button
              key={id}
              aria-current={tab === id && !sessionKey}
              onClick={() => {
                setTab(id);
                setSessionKey(null);
              }}
            >
              {label}
            </button>
          ))}
        </nav>

        {(tab === 'overview' || tab === 'compare') && !sessionKey && (
          <div className="seg">
            {[1, 7, 14, 30].map((d) => (
              <button key={d} aria-pressed={days === d} onClick={() => setDays(d)}>
                {d}d
              </button>
            ))}
          </div>
        )}

        {tab !== 'compare' && tab !== 'sources' && !sessionKey && (
          <div className="seg">
            {(
              [
                ['all', 'All'],
                ['codex', 'Codex'],
                ['claude-code', 'Claude Code'],
              ] as Array<[ProviderId | 'all', string]>
            ).map(([id, label]) => (
              <button key={id} aria-pressed={provider === id} onClick={() => setProvider(id)}>
                {label}
              </button>
            ))}
          </div>
        )}

        <div className="topbar-right">
          <span className="privacy-banner" title="No telemetry. No outbound network requests.">
            🔒 local only
          </span>
          {scanning ? (
            <span className="dim">
              <span className="spin" /> scanning {progress?.filesDone ?? 0}/{progress?.filesTotal ?? 0}
            </span>
          ) : (
            <span className="dim">
              {status?.sessionCount ?? 0} sessions · {status?.timezone ?? ''}
            </span>
          )}
          <button
            className="btn"
            onClick={() => {
              void api.rescan();
            }}
            disabled={scanning}
          >
            rescan
          </button>
        </div>
      </header>

      {scanning && pct !== null && (
        <div className="progress">
          <i style={{ width: `${pct}%` }} />
        </div>
      )}

      <main className="main">
        {status && status.roots.length === 0 && !scanning && (
          <div className="note warn">
            No Codex or Claude Code data directories were found on this machine. Open{' '}
            <strong>Sources</strong> to add one manually.
          </div>
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
