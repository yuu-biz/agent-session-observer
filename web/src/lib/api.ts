import type { DayResponse, OverviewResponse, ProviderComparison, StatusResponse } from '@api/api';
import type { AppConfig } from '@core/config';
import type { SessionDetail } from '@core/types';

/**
 * Every request goes to this app's own origin, which is a loopback address.
 * There is deliberately no base-URL setting: the UI must not be pointable at a
 * remote host, because the payloads contain prompt text.
 */

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const api = {
  status: () => get<StatusResponse>('/api/status'),
  overview: (days: number, provider: string) =>
    get<OverviewResponse>(`/api/overview?days=${days}&provider=${encodeURIComponent(provider)}`),
  day: (date: string, provider: string) =>
    get<DayResponse>(`/api/day?date=${date}&provider=${encodeURIComponent(provider)}`),
  comparison: (days: number) => get<ProviderComparison[]>(`/api/comparison?days=${days}`),
  session: (key: string) => get<SessionDetail>(`/api/session?key=${encodeURIComponent(key)}`),
  rescan: () => fetch('/api/rescan', { method: 'POST' }),
  /** Asks the packaged app to shut itself down. No-op for an embedded server. */
  quit: () => fetch('/api/quit', { method: 'POST' }),
  saveConfig: async (config: AppConfig): Promise<AppConfig> => {
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return (await res.json()) as AppConfig;
  },
};

/**
 * Subscribes to server-sent scan events. Returns an unsubscribe function.
 * EventSource reconnects on its own, so a server restart during development
 * does not require a page reload.
 */
export function subscribe(onEvent: (type: string, data: unknown) => void): () => void {
  const source = new EventSource('/api/events');
  const handler = (type: string) => (e: MessageEvent<string>) => {
    try {
      onEvent(type, JSON.parse(e.data));
    } catch {
      onEvent(type, null);
    }
  };
  for (const type of ['hello', 'progress', 'scan']) {
    source.addEventListener(type, handler(type) as EventListener);
  }
  return () => source.close();
}
