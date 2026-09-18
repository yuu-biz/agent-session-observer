import { createReadStream, existsSync, promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, normalizeConfig, saveConfig, type AppConfig } from '../core/config.js';
import { localDayKey, localTimeZoneName } from '../core/time.js';
import type { ProviderId } from '../core/types.js';
import { SessionScanner, type ScanProgress } from '../indexer/scanner.js';
import { buildComparison, buildDay, buildOverview, type StatusResponse } from './api.js';

/**
 * Local HTTP server.
 *
 * Security posture, and the reasons for it:
 *  - binds to 127.0.0.1 only, so nothing on the LAN can reach it;
 *  - rejects requests whose `Host` header is not a loopback name, which is what
 *    stops DNS rebinding from turning a website into a reader of your prompts;
 *  - rejects cross-origin requests outright rather than negotiating CORS;
 *  - serves only files inside the bundled web directory, with the resolved path
 *    re-checked against that directory after normalisation;
 *  - makes no outbound network calls of any kind.
 */

/**
 * Where the bundled UI lives.
 *
 * Three shapes have to work: a normal `npm install` (assets sit beside the
 * compiled server), a standalone executable with `dist/` next to it, and one
 * with the assets flattened beside the binary. `import.meta.url` is unavailable
 * inside a single-executable build, so its absence is expected, not an error.
 */
function resolveStaticDir(): string {
  const candidates: string[] = [];
  try {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.join(moduleDir, '..', 'web'));
  } catch {
    // Bundled into a single executable; fall through to exec-relative paths.
  }
  const execDir = path.dirname(process.execPath);
  candidates.push(path.join(execDir, 'dist', 'web'), path.join(execDir, 'web'));

  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return candidates[0] ?? path.join(execDir, 'web');
}

const STATIC_DIR = resolveStaticDir();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostIsLoopback(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, '').toLowerCase();
  return LOOPBACK_HOSTS.has(host);
}

function originIsLocal(origin: string | undefined): boolean {
  if (!origin) return true; // same-origin fetches send no Origin header
  try {
    const url = new URL(origin);
    return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export interface ServerHandle {
  url: string;
  port: number;
  close(): Promise<void>;
  scanner: SessionScanner;
}

interface SseClient {
  res: http.ServerResponse;
}

export interface StartServerOptions {
  config: AppConfig;
  /** Dev mode serves nothing static and expects Vite on another port. */
  dev?: boolean;
  version: string;
}

export async function startServer(options: StartServerOptions): Promise<ServerHandle> {
  let config = options.config;
  let lastProgress: ScanProgress | null = null;

  const scanner = new SessionScanner({
    config,
    onProgress: (p) => {
      lastProgress = p;
      broadcast('progress', p);
    },
  });

  const clients = new Set<SseClient>();
  /**
   * The scan in flight, if any. `close()` awaits it: a scan writes the parse
   * cache, and a server that returns from `close()` while a write is still
   * pending leaves the caller unable to clean up after it.
   */
  let inFlight: Promise<unknown> | null = null;

  function startScan(): void {
    const run = scanner.scan().then(
      (r) => broadcast('scan', { sessions: r.sessions.length, durationMs: r.durationMs }),
      () => undefined,
    );
    inFlight = run.finally(() => {
      if (inFlight === run) inFlight = null;
    });
  }

  function broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) {
      try {
        client.res.write(payload);
      } catch {
        clients.delete(client);
      }
    }
  }

  function json(res: http.ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(text);
  }

  function statusPayload(): StatusResponse {
    const last = scanner.getLastResult();
    return {
      scanning: scanner.isScanning,
      progress: lastProgress,
      scannedAt: last?.scannedAt ?? null,
      durationMs: last?.durationMs ?? null,
      filesScanned: last?.filesScanned ?? 0,
      filesParsed: last?.filesParsed ?? 0,
      sessionCount: scanner.getSessions().length,
      duplicateCount: scanner.getDuplicates().length,
      roots: [...(last?.roots ?? scanner.getRoots())],
      notes: last?.notes ?? [],
      warnings: last?.warnings ?? [],
      timezone: localTimeZoneName(),
      today: localDayKey(Date.now()),
      config,
      version: options.version,
      localOnly: true,
    };
  }

  async function readBody(req: http.IncomingMessage, limit = 256 * 1024): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > limit) throw new Error('request body too large');
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async function serveStatic(res: http.ServerResponse, urlPath: string): Promise<void> {
    if (options.dev) {
      json(res, 404, { error: 'dev mode: run `npm run dev:web` and use the Vite URL' });
      return;
    }
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const resolved = path.resolve(STATIC_DIR, rel);
    // Re-check after resolution: this is what makes `../` traversal impossible.
    if (resolved !== STATIC_DIR && !resolved.startsWith(STATIC_DIR + path.sep)) {
      json(res, 403, { error: 'forbidden' });
      return;
    }

    let target = resolved;
    try {
      const st = await fs.stat(target);
      if (st.isDirectory()) target = path.join(target, 'index.html');
    } catch {
      // Single-page app: unknown paths fall back to the shell document.
      target = path.join(STATIC_DIR, 'index.html');
    }

    try {
      await fs.access(target);
    } catch {
      json(res, 404, { error: 'not found' });
      return;
    }

    res.writeHead(200, {
      'content-type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': target.endsWith('index.html') ? 'no-store' : 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
    });
    createReadStream(target).pipe(res);
  }

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err: Error) => {
      if (!res.headersSent) json(res, 500, { error: err.message });
      else res.end();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!hostIsLoopback(req.headers.host)) {
      json(res, 421, { error: 'this server only accepts loopback requests' });
      return;
    }
    if (!originIsLocal(req.headers.origin)) {
      json(res, 403, { error: 'cross-origin requests are not accepted' });
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;
    const provider = (url.searchParams.get('provider') ?? 'all') as ProviderId | 'all';
    const days = Number(url.searchParams.get('days') ?? '7');

    if (!pathname.startsWith('/api/')) {
      await serveStatic(res, pathname);
      return;
    }

    switch (`${req.method} ${pathname}`) {
      case 'GET /api/status':
        json(res, 200, statusPayload());
        return;

      case 'GET /api/overview':
        json(
          res,
          200,
          buildOverview(scanner, {
            days: Number.isFinite(days) ? days : 7,
            provider,
            now: Date.now(),
          }),
        );
        return;

      case 'GET /api/day': {
        const dayKey = url.searchParams.get('date') ?? localDayKey(Date.now());
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
          json(res, 400, { error: 'date must be YYYY-MM-DD' });
          return;
        }
        json(res, 200, buildDay(scanner, { dayKey, provider }));
        return;
      }

      case 'GET /api/comparison':
        json(res, 200, buildComparison(scanner, { days: Number.isFinite(days) ? days : 7, now: Date.now() }));
        return;

      case 'GET /api/session': {
        const key = url.searchParams.get('key');
        if (!key) {
          json(res, 400, { error: 'key is required' });
          return;
        }
        const detail = await scanner.loadDetail(key);
        if (!detail) {
          json(res, 404, { error: 'session not found' });
          return;
        }
        json(res, 200, detail);
        return;
      }

      case 'POST /api/rescan':
        startScan();
        json(res, 202, { started: true });
        return;

      case 'PUT /api/config': {
        const body = await readBody(req);
        const next = normalizeConfig(JSON.parse(body));
        // The port is process-scoped; changing it here would be a lie.
        const merged: AppConfig = { ...next, port: config.port };
        await saveConfig(merged);
        config = merged;
        scanner.updateConfig(merged);
        startScan();
        json(res, 200, merged);
        return;
      }

      case 'GET /api/events': {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        res.write(`event: hello\ndata: ${JSON.stringify(statusPayload())}\n\n`);
        const client: SseClient = { res };
        clients.add(client);
        const keepAlive = setInterval(() => {
          try {
            res.write(': ping\n\n');
          } catch {
            clearInterval(keepAlive);
          }
        }, 20_000);
        req.on('close', () => {
          clearInterval(keepAlive);
          clients.delete(client);
        });
        return;
      }

      default:
        json(res, 404, { error: 'unknown endpoint' });
    }
  }

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    // 127.0.0.1, never 0.0.0.0: the dashboard shows local prompt text.
    server.listen(config.port, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : config.port);
    });
  });

  // Background refresh loop. Polling is used rather than fs.watch because
  // watchers are unreliable over UNC / WSL paths and differ across platforms;
  // a cheap stat-based rescan behaves identically everywhere.
  const timer = setInterval(() => {
    if (scanner.isScanning) return;
    startScan();
  }, config.refreshIntervalMs);
  timer.unref?.();

  startScan();

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    scanner,
    async close() {
      clearInterval(timer);
      for (const client of clients) client.res.end();
      clients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // Let the current scan finish writing before returning.
      await inFlight?.catch(() => undefined);
    },
  };
}

export async function loadServerConfig(): Promise<AppConfig> {
  return loadConfig();
}
