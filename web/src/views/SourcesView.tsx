import type { StatusResponse } from '@api/api';
import type { AppConfig } from '@core/config';
import type { ProviderId } from '@core/types';
import { useEffect, useState } from 'react';

import { Panel } from '../components/Tiles';
import { api } from '../lib/api';
import { PROVIDER_LABEL, useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';

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
  const { t } = useI18n();
  const f = useFormat();
  const [draft, setDraft] = useState<AppConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [newRoot, setNewRoot] = useState({ provider: 'codex' as ProviderId, path: '' });

  useEffect(() => {
    if (status && !draft) setDraft(status.config);
  }, [status, draft]);

  if (!status || !draft) return <div className="empty">{t('common.loading')}</div>;

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
      <Panel title={t('sources.discovered')} flush>
        {status.roots.length === 0 ? (
          <div className="empty">{t('sources.empty')}</div>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>{t('table.provider')}</th>
                <th>{t('table.host')}</th>
                <th>{t('sources.colPath')}</th>
                <th>{t('sources.colFoundVia')}</th>
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
        <Panel title={t('sources.notes')}>
          <div style={{ display: 'grid', gap: 6 }}>
            {status.notes.map((n, i) => (
              <div key={i} className="note">
                {n}
              </div>
            ))}
          </div>
        </Panel>
      )}

      <Panel title={t('sources.analysis')}>
        <div style={{ display: 'grid', gap: 14, maxWidth: 640 }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span>
              <strong>{t('sources.idleThreshold')}</strong>{' '}
              <span className="dim">
                — {t('sources.idleThresholdHelp', { value: f.duration(draft.idleThresholdMs) })}
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
              {t('sources.idleThresholdNote')}
            </span>
          </label>

          <label style={{ display: 'grid', gap: 4 }}>
            <span>
              <strong>{t('sources.wsl')}</strong>
            </span>
            <select
              value={draft.wslMode}
              onChange={(e) => {
                const next = { ...draft, wslMode: e.target.value as AppConfig['wslMode'] };
                setDraft(next);
                void save(next);
              }}
            >
              <option value="running">{t('sources.wslRunning')}</option>
              <option value="all">{t('sources.wslAll')}</option>
              <option value="off">{t('sources.wslOff')}</option>
            </select>
            <span className="faint" style={{ fontSize: 11 }}>
              {t('sources.wslNote')}
            </span>
          </label>

          <label style={{ display: 'grid', gap: 4 }}>
            <span>
              <strong>{t('sources.lookback')}</strong>{' '}
              <span className="dim">{t('sources.lookbackHelp')}</span>
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

      <Panel title={t('sources.extra')}>
        <p className="dim" style={{ marginTop: 0 }}>
          {t('sources.extraHelp')}
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
                      {t('sources.remove')}
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
            <option value="codex">{t('common.codex')}</option>
            <option value="claude-code">{t('common.claudeCode')}</option>
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
            {t('sources.add')}
          </button>
        </div>
      </Panel>

      {status.warnings.length > 0 && (
        <Panel title={t('sources.warnings', { n: status.warnings.length })}>
          <div className="scroll-y" style={{ maxHeight: 240, display: 'grid', gap: 4 }}>
            {status.warnings.map((w, i) => (
              <div key={i} className="mono faint" style={{ fontSize: 11 }}>
                {w}
              </div>
            ))}
          </div>
        </Panel>
      )}

      <Panel title={t('sources.privacy')}>
        <ul className="dim" style={{ margin: 0, paddingLeft: 18 }}>
          <li>{t('sources.privacy1')}</li>
          <li>{t('sources.privacy2')}</li>
          <li>{t('sources.privacy3')}</li>
          <li>{t('sources.privacy4')}</li>
          <li>{t('sources.privacy5')}</li>
        </ul>
      </Panel>
    </>
  );
}
