import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { directoryExists } from './fs-scan.js';

/**
 * WSL discovery
 * =============
 *
 * Reading a path under `\\wsl.localhost\<distro>\` STARTS that distribution if
 * it is not already running. Booting a user's distro as a side effect of
 * opening a dashboard is not acceptable, so the default mode only inspects
 * distributions that are already running. `all` is opt-in and documented as
 * "this will start stopped distributions".
 *
 * `wsl.exe -l -q` is used rather than the registry because it needs no
 * elevation, is stable across WSL versions, and returns names unambiguously —
 * but note it emits UTF-16LE, which is decoded explicitly below. Listing does
 * not start anything.
 */

export type WslMode = 'running' | 'all' | 'off';

export interface WslDistro {
  name: string;
  running: boolean;
  /** `\\wsl.localhost\<name>` */
  uncRoot: string;
}

/** Distributions that never contain a user's agent logs. */
const SYSTEM_DISTROS = new Set(['docker-desktop', 'docker-desktop-data', 'rancher-desktop-data']);

const WSL_TIMEOUT_MS = 5_000;

/** Exported for tests. */
export function isSystemDistro(name: string): boolean {
  return SYSTEM_DISTROS.has(name.toLowerCase());
}

/** Exported for tests: `wsl.exe` speaks UTF-16LE, with or without a BOM. */
export function decodeUtf16(buf: Buffer): string {
  // `wsl.exe` writes UTF-16LE, sometimes with a BOM.
  const body = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe ? buf.subarray(2) : buf;
  return body.toString('utf16le');
}

async function runWsl(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        'wsl.exe',
        args,
        { timeout: WSL_TIMEOUT_MS, windowsHide: true, encoding: 'buffer', maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          if (err && !stdout) {
            resolve(null);
            return;
          }
          resolve(decodeUtf16(stdout as unknown as Buffer));
        },
      );
      child.on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

/** Exported for tests: parses `wsl -l -q` output into distribution names. */
export function parseNames(output: string | null): string[] {
  if (!output) return [];
  return output
    .split(/\r?\n/)
    .map((line) => line.replace(/\0/g, '').trim())
    .filter((line) => line.length > 0);
}

/** Lists WSL distributions. Does not start any of them. */
export async function listWslDistros(): Promise<WslDistro[]> {
  if (process.platform !== 'win32') return [];

  const [allOut, runningOut] = await Promise.all([
    runWsl(['-l', '-q']),
    runWsl(['-l', '-q', '--running']),
  ]);

  const all = parseNames(allOut);
  if (all.length === 0) return [];
  const running = new Set(parseNames(runningOut));

  return all
    .filter((name) => !isSystemDistro(name))
    .map((name) => ({
      name,
      running: running.has(name),
      uncRoot: `\\\\wsl.localhost\\${name}`,
    }));
}

/**
 * Home directories inside a distro: every `/home/<user>` plus `/root`.
 *
 * `/root` is usually unreadable from Windows (permission denied) and is simply
 * skipped when so; we never elevate or invoke `wsl.exe` to read files.
 */
export async function listWslHomes(distro: WslDistro): Promise<string[]> {
  const homes: string[] = [];
  const homeDir = path.join(distro.uncRoot, 'home');

  try {
    const entries = await fs.readdir(homeDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      homes.push(path.join(homeDir, entry.name));
    }
  } catch {
    // Distro not reachable (stopped, or \\wsl.localhost unavailable).
  }

  const root = path.join(distro.uncRoot, 'root');
  if (await directoryExists(root)) homes.push(root);

  return homes;
}

export interface WslDiscoveryResult {
  distros: WslDistro[];
  /** Home directories that were actually inspected. */
  homes: Array<{ distro: string; home: string }>;
  /** Distros skipped because they were not running and mode is `running`. */
  skipped: Array<{ distro: string; reason: string }>;
}

export async function discoverWslHomes(mode: WslMode): Promise<WslDiscoveryResult> {
  const result: WslDiscoveryResult = { distros: [], homes: [], skipped: [] };
  if (mode === 'off' || process.platform !== 'win32') return result;

  result.distros = await listWslDistros();

  for (const distro of result.distros) {
    if (mode === 'running' && !distro.running) {
      result.skipped.push({
        distro: distro.name,
        reason: 'not running (scanning it would start the distribution)',
      });
      continue;
    }
    for (const home of await listWslHomes(distro)) {
      result.homes.push({ distro: distro.name, home });
    }
  }
  return result;
}
