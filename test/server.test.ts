import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../src/core/config.js';
import { startServer, type ServerHandle } from '../src/server/http.js';
import { parseArgs } from '../src/cli/main.js';
import { CLAUDE_ROOT, CODEX_ROOT } from './helpers.js';

/**
 * The HTTP layer's security boundary is load bearing: this process reads and
 * serves the user's prompt text, so anything that could let another origin or
 * another host reach it is a real vulnerability, not a nitpick.
 */

let server: ServerHandle;
let base: string;
let cacheHome: string;
const original = process.env.AGENT_SESSION_OBSERVER_HOME;

beforeAll(async () => {
  cacheHome = await mkdtemp(path.join(os.tmpdir(), 'aso-srv-'));
  process.env.AGENT_SESSION_OBSERVER_HOME = cacheHome;
  server = await startServer({
    config: {
      ...DEFAULT_CONFIG,
      port: 0, // let the OS pick a free port
      wslMode: 'off',
      lookbackDays: 3650,
      refreshIntervalMs: 600_000, // no background rescans during the test
      extraRoots: [
        { provider: 'codex', path: CODEX_ROOT },
        { provider: 'claude-code', path: CLAUDE_ROOT },
      ],
    },
    dev: true,
    version: 'test',
  });
  base = server.url;
});

afterAll(async () => {
  await server.close();
  if (original === undefined) delete process.env.AGENT_SESSION_OBSERVER_HOME;
  else process.env.AGENT_SESSION_OBSERVER_HOME = original;
  // Retries guard against a filesystem that is still settling on slower CI
  // runners; the server has already awaited its own writes by this point.
  await rm(cacheHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('server binding', () => {
  it('listens on loopback only', () => {
    expect(base.startsWith('http://127.0.0.1:')).toBe(true);
  });
});

/**
 * `fetch` refuses to let callers set `Host`, so the rebinding guard has to be
 * exercised with a raw request.
 */
function rawRequest(headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: server.port, path: '/api/status', method: 'GET', headers },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('request guards', () => {
  it('rejects a request whose Host header is not loopback (DNS rebinding)', async () => {
    expect(await rawRequest({ host: 'attacker.example.com' })).toBe(421);
    expect(await rawRequest({ host: 'attacker.example.com:7781' })).toBe(421);
  });

  it('accepts loopback Host headers in every spelling', async () => {
    expect(await rawRequest({ host: `127.0.0.1:${server.port}` })).toBe(200);
    expect(await rawRequest({ host: `localhost:${server.port}` })).toBe(200);
  });

  it('rejects a cross-origin request instead of negotiating CORS', async () => {
    const res = await fetch(`${base}/api/status`, {
      headers: { origin: 'https://attacker.example.com' },
    });
    expect(res.status).toBe(403);
  });

  it('accepts a same-origin request with no Origin header', async () => {
    const res = await fetch(`${base}/api/status`);
    expect(res.status).toBe(200);
  });

  it('accepts a loopback Origin', async () => {
    const res = await fetch(`${base}/api/status`, { headers: { origin: base } });
    expect(res.status).toBe(200);
  });

  it('sends no CORS allow header at all', async () => {
    const res = await fetch(`${base}/api/status`);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('marks JSON responses nosniff and no-store', async () => {
    const res = await fetch(`${base}/api/status`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('api endpoints', () => {
  it('reports status, including that it is local only', async () => {
    const body = (await (await fetch(`${base}/api/status`)).json()) as Record<string, unknown>;
    expect(body.localOnly).toBe(true);
    expect(body.version).toBe('test');
    expect(typeof body.timezone).toBe('string');
    expect(Array.isArray(body.roots)).toBe(true);
  });

  it('validates the date parameter', async () => {
    const bad = await fetch(`${base}/api/day?date=not-a-date`);
    expect(bad.status).toBe(400);
    const good = await fetch(`${base}/api/day?date=2024-03-04`);
    expect(good.status).toBe(200);
  });

  it('requires a session key and 404s on an unknown one', async () => {
    expect((await fetch(`${base}/api/session`)).status).toBe(400);
    expect((await fetch(`${base}/api/session?key=codex:nope`)).status).toBe(404);
  });

  it('404s an unknown endpoint rather than guessing', async () => {
    expect((await fetch(`${base}/api/does-not-exist`)).status).toBe(404);
  });

  it('serves the overview and comparison shapes the UI expects', async () => {
    const overview = (await (await fetch(`${base}/api/overview?days=7`)).json()) as {
      days: unknown[];
      totals: Record<string, unknown>;
      live: unknown[];
    };
    expect(overview.days).toHaveLength(7);
    expect(typeof overview.totals.clockActiveMs).toBe('number');
    expect(Array.isArray(overview.live)).toBe(true);

    const comparison = (await (await fetch(`${base}/api/comparison?days=7`)).json()) as Array<{
      provider: string;
      unavailable: string[];
    }>;
    expect(comparison.map((c) => c.provider)).toEqual(['codex', 'claude-code']);
    // Codex records no cost; that must be stated, not shown as zero.
    expect(comparison[0]?.unavailable.join(' ')).toContain('cost');
  });
});

describe('cli argument parsing', () => {
  it('parses the documented flags', () => {
    const args = parseArgs(['--port', '9999', '--no-open', '--wsl', 'off']);
    expect(args).toMatchObject({ port: 9999, open: false, wsl: 'off' });
  });

  it('ignores an out-of-range port rather than crashing', () => {
    expect(parseArgs(['--port', '99999']).port).toBeUndefined();
    expect(parseArgs(['--port', 'abc']).port).toBeUndefined();
  });

  it('rejects an unknown --wsl mode', () => {
    expect(parseArgs(['--wsl', 'everything']).wsl).toBeUndefined();
  });

  it('implies --no-open in dev mode', () => {
    expect(parseArgs(['--dev'])).toMatchObject({ dev: true, open: false });
  });

  it('defaults to opening a browser', () => {
    expect(parseArgs([]).open).toBe(true);
  });
});
