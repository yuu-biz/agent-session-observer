import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { configDir } from '../core/config.js';

/**
 * App lifecycle helpers.
 *
 * The packaged build has no console, which changes what "handled" means: an
 * error nobody can see is the same as a crash. Two situations caused by that
 * are dealt with here.
 *
 * 1. Launching a second copy. The port is already taken, `listen` fails with
 *    EADDRINUSE, and the process dies without a word — the app simply "does not
 *    open". A desktop application is expected to surface the window it already
 *    has instead.
 *
 * 2. Knowing when the window closed. Watching the browser process does not
 *    work: browsers routinely hand a URL to another process and exit at once,
 *    so process lifetime says nothing about whether a window is open. The page
 *    holds an event stream, so client presence is the reliable signal.
 */

/** How long the app tolerates having no UI connected before quitting. */
export const WINDOW_CLOSED_GRACE_MS = 10_000;
/** How long to wait for the window to appear at all before giving up. */
export const WINDOW_OPEN_TIMEOUT_MS = 90_000;

export function isAddressInUse(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE';
}

export interface RunningInstance {
  url: string;
  version: string;
}

/**
 * Asks whether the process holding a port is another copy of this app.
 *
 * This is a loopback request to 127.0.0.1 — the app still makes no outbound
 * network requests. It exists so that a second launch can reuse the running
 * instance rather than failing, and so that an unrelated service on the port is
 * never mistaken for one of ours.
 */
export function probeRunningInstance(port: number, timeoutMs = 1500): Promise<RunningInstance | null> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/status', method: 'GET', timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
          if (body.length > 1_000_000) req.destroy();
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body) as { localOnly?: unknown; version?: unknown };
            // `localOnly` is only ever emitted by this app's status endpoint.
            if (parsed.localOnly === true && typeof parsed.version === 'string') {
              resolve({ url: `http://127.0.0.1:${port}`, version: parsed.version });
              return;
            }
          } catch {
            // Not JSON, so not us.
          }
          resolve(null);
        });
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

/**
 * Records a startup failure where the user can find it.
 *
 * Without a console this is the only trace a failed launch would otherwise
 * leave, so it is written even though nothing reads it automatically.
 */
export async function writeStartupError(error: unknown): Promise<string | null> {
  const file = path.join(configDir(), 'last-error.log');
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${new Date().toISOString()}\n${message}\n`, 'utf8');
    return file;
  } catch {
    return null;
  }
}

export interface WindowWatchOptions {
  onClosed: () => void;
  /** Injected in tests. */
  graceMs?: number;
  openTimeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (handle: NodeJS.Timeout) => void;
}

export interface WindowWatch {
  /** Feed the current number of connected UI clients. */
  update(count: number): void;
  /** Stop watching; used when the app is quitting for another reason. */
  dispose(): void;
}

/**
 * Quits the app once the window that was open has gone away.
 *
 * Deliberately tolerant of a brief drop to zero clients, because a page reload
 * looks exactly like a close for a moment. And deliberately silent until the
 * first client arrives, so a slow-starting browser is not mistaken for a closed
 * window — with a separate, longer timeout for a window that never appears at
 * all, which would otherwise leave a server running with no way to reach it.
 */
export function watchWindow(options: WindowWatchOptions): WindowWatch {
  const grace = options.graceMs ?? WINDOW_CLOSED_GRACE_MS;
  const openTimeout = options.openTimeoutMs ?? WINDOW_OPEN_TIMEOUT_MS;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h));

  let sawClient = false;
  let disposed = false;
  let idleTimer: NodeJS.Timeout | null = null;

  let openTimer: NodeJS.Timeout | null = setTimer(() => {
    openTimer = null;
    if (!disposed && !sawClient) options.onClosed();
  }, openTimeout);
  openTimer.unref?.();

  const cancelIdle = (): void => {
    if (idleTimer) {
      clearTimer(idleTimer);
      idleTimer = null;
    }
  };

  return {
    update(count: number): void {
      if (disposed) return;
      if (count > 0) {
        sawClient = true;
        if (openTimer) {
          clearTimer(openTimer);
          openTimer = null;
        }
        cancelIdle();
        return;
      }
      if (!sawClient || idleTimer) return;
      idleTimer = setTimer(() => {
        idleTimer = null;
        if (!disposed) options.onClosed();
      }, grace);
      idleTimer.unref?.();
    },
    dispose(): void {
      disposed = true;
      cancelIdle();
      if (openTimer) {
        clearTimer(openTimer);
        openTimer = null;
      }
    },
  };
}
