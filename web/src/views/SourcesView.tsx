import type { StatusResponse } from '@api/api';
import type { AppConfig } from '@core/config';
import type { ProviderId } from '@core/types';
import { useEffect, useState } from 'react';

import { Panel } from '../components/Tiles';
import { api } from '../lib/api';
import { fmtDuration, PROVIDER_LABEL } from '../lib/format';

/**
 * Sources & settings.
 *
 * Auto discovery is the product, so this screen's job is to make it auditable:
 * exactly which directories were found, how they were found, and what was
 * deliberately skipped. Manual roots exist only as a fallback for layouts the
 * defaults miss.
 */
export function SourcesView({
  status,
  onConfigSaved,
}: {
  status: StatusResponse | null;
  onConfigSaved: () => void;
}): React.ReactElement {
  const [draft, setDraft] = useState<AppConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [newRoot, setNewRoot] = useState({ provider: 'codex' as ProviderId, path: '' });

  useEffect(() => {
    if (status && !draft) setDraft(status.config);
  }, [status, draft]);

  if (!status || !draft) return <div className="empty">Loading…</div>;

  const save = async (next: AppConfig): Promise<void> => {
    setSaving(true);
    try {
      const saved = await api.saveConfig(next);
      setDraft(saved);
      onConfigSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Panel title="Discovered sources" flush>
        {status.roots.length === 0 ? (
          <div className="empty">
            Nothing found automatically. Add a directory below — it should be the provider home
            (the folder that contains <code>sessions/</code> or <code>projects/</code>).
          </div>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Host</th>
                <th>Path</th>
                <th>Found via</th>
              </tr>
            </thead>
            <tbody>
              {status.roots.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span className={`badge ${r.provider}`}>{PROVIDER_LABEL[r.provider]}</span>
                  </td>
                  <td className="mono dim">{r.host.label}</td>
                  <td className="mono" style={{ fontSize: 11.5 }}>
                    {r.path}
                  </td>
                  <td className="dim">{r.origin}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {status.notes.length > 0 && (
        <Panel title="Discovery notes">
          <div style={{ display: 'grid', gap: 6 }}>
            {status.notes.map((n, i) => (
              <div key={i} className="note">
                {n}
              </div>
            ))}
          </div>
        </Panel>
      )}

      <Panel title="Analysis settings">
        <div style={{ display: 'grid', gap: 14, maxWidth: 640 }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span>
              <strong>Idle threshold</strong>{' '}
              <span className="dim">
                — a gap longer than this splits a session into separate active segments. Current:{' '}
                {fmtDuration(draft.idleThresholdMs)}
              </span>
            </span>
            <input
              type="range"
              min={30}
              max={1800}
              step={30}
              value={Math.round(draft.idleThresholdMs / 1000)}
              onChange={(e) => setDraft({ ...draft, idleThresholdMs: Number(e.target.value) * 1000 })}
              onMouseUp={() => void save(draft)}
              onTouchEnd={() => void save(draft)}
            />
            <span className="faint" style={{ fontSize: 11 }}>
              Raising it counts short pauses as work; lowering it counts only tightly packed
              activity. Every “active”, “idle” and concurrency figure in the app follows this value.
            </span>
          </label>

          <label style={{ display: 'grid', gap: 4 }}>
            <span>
              <strong>WSL scanning</strong>
            </span>
            <select
              value={draft.wslMode}
              onChange={(e) => {
                const next = { ...draft, wslMode: e.target.value as AppConfig['wslMode'] };
                setDraft(next);
                void save(next);
              }}
            >
              <option value="running">Running distributions only (recommended)</option>
              <option value="all">All distributions — will start stopped ones</option>
              <option value="off">Do not scan WSL</option>
            </select>
            <span className="faint" style={{ fontSize: 11 }}>
              Reading a path inside a stopped distribution boots it. The default avoids that side
              effect and simply reports which distributions were skipped.
            </span>
          </label>

          <label style={{ display: 'grid', gap: 4 }}>
            <span>
              <strong>History window</strong> <span className="dim">days of logs loaded</span>
            </span>
            <input
              type="number"
              min={1}
              max={3650}
              value={draft.lookbackDays}
              onChange={(e) => setDraft({ ...draft, lookbackDays: Number(e.target.value) })}
              onBlur={() => void save(draft)}
              style={{ width: 120 }}
            />
          </label>
        </div>
      </Panel>

      <Panel title="Additional log directories">
        <p className="dim" style={{ marginTop: 0 }}>
          Only needed when auto discovery misses a location — for example a custom{' '}
          <code>CODEX_HOME</code> on another drive. Point at the provider home directory.
        </p>
        {draft.extraRoots.length > 0 && (
          <table className="grid" style={{ marginBottom: 10 }}>
            <tbody>
              {draft.extraRoots.map((r, i) => (
                <tr key={`${r.provider}:${r.path}`}>
                  <td>
                    <span className={`badge ${r.provider}`}>{PROVIDER_LABEL[r.provider]}</span>
                  </td>
                  <td className="mono">{r.path}</td>
                  <td style={{ width: 1 }}>
                    <button
                      className="btn"
                      onClick={() => {
                        const next = {
                          ...draft,
                          extraRoots: draft.extraRoots.filter((_, j) => j !== i),
                        };
                        setDraft(next);
                        void save(next);
                      }}
                    >
                      remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="controls">
          <select
            value={newRoot.provider}
            onChange={(e) => setNewRoot({ ...newRoot, provider: e.target.value as ProviderId })}
          >
            <option value="codex">Codex</option>
            <option value="claude-code">Claude Code</option>
          </select>
          <input
            type="text"
            placeholder="C:\path\to\.codex"
            value={newRoot.path}
            onChange={(e) => setNewRoot({ ...newRoot, path: e.target.value })}
            style={{ minWidth: 320 }}
          />
          <button
            className="btn primary"
            disabled={newRoot.path.trim().length === 0 || saving}
            onClick={() => {
              const next = {
                ...draft,
                extraRoots: [...draft.extraRoots, { ...newRoot, path: newRoot.path.trim() }],
              };
              setDraft(next);
              setNewRoot({ ...newRoot, path: '' });
              void save(next);
            }}
          >
            add
          </button>
        </div>
      </Panel>

      {status.warnings.length > 0 && (
        <Panel title={`Scan warnings (${status.warnings.length})`}>
          <div className="scroll-y" style={{ maxHeight: 240, display: 'grid', gap: 4 }}>
            {status.warnings.map((w, i) => (
              <div key={i} className="mono faint" style={{ fontSize: 11 }}>
                {w}
              </div>
            ))}
          </div>
        </Panel>
      )}

      <Panel title="Privacy">
        <ul className="dim" style={{ margin: 0, paddingLeft: 18 }}>
          <li>Every log file is opened read-only. Nothing in your Codex or Claude Code directories is modified.</li>
          <li>No telemetry, no analytics, no update checks, no outbound network requests at all.</li>
          <li>
            The server listens on 127.0.0.1 only, rejects non-loopback <code>Host</code> headers, and
            rejects cross-origin requests.
          </li>
          <li>
            Prompt text is rendered in this UI because it is your own log content on your own
            machine. It is never transmitted anywhere.
          </li>
          <li>
            A parse cache lives in <code className="mono">~/.agent-session-observer/</code>. Deleting
            it is always safe.
          </li>
        </ul>
      </Panel>
    </>
  );
}
