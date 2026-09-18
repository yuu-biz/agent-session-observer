import os from 'node:os';
import path from 'node:path';

import { claudeCodeAdapter } from '../adapters/claude-code/index.js';
import { codexAdapter } from '../adapters/codex/index.js';
import type { DiscoveryRoot, HostRef, ProviderAdapter, ProviderId } from '../core/types.js';
import { directoryExists } from './fs-scan.js';
import { discoverWslHomes, type WslMode } from './wsl.js';

/**
 * Root discovery
 * ==============
 *
 * The product promise is "launch it and see your activity", so discovery is
 * ordered by how much we trust each source, and never scans a home directory
 * recursively:
 *
 *   1. explicit env override  (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`)
 *   2. the local home directory
 *   3. macOS: `~/Library/Application Support/<provider>` if it ever appears
 *   4. WSL home directories (Windows host only, running distros by default)
 *   5. user-configured extra roots (the fallback when 1-4 find nothing)
 *
 * Each candidate is a *provider home* (e.g. `.../.codex`). A candidate becomes
 * a root only if the directory exists.
 */

export const ADAPTERS: readonly ProviderAdapter[] = [codexAdapter, claudeCodeAdapter];

export function getAdapter(provider: ProviderId): ProviderAdapter {
  const found = ADAPTERS.find((a) => a.id === provider);
  if (!found) throw new Error(`unknown provider: ${provider}`);
  return found;
}

const LOCAL_HOST: HostRef = { kind: 'local', label: 'local' };

function wslHost(distro: string): HostRef {
  return { kind: 'wsl', distro, label: `wsl:${distro}` };
}

function makeRoot(
  provider: ProviderId,
  host: HostRef,
  rootPath: string,
  origin: DiscoveryRoot['origin'],
): DiscoveryRoot {
  return {
    id: `${provider}:${host.label}:${rootPath}`,
    provider,
    host,
    path: rootPath,
    origin,
  };
}

export interface DiscoveryOptions {
  wslMode: WslMode;
  /** Extra provider-home directories supplied by the user. */
  extraRoots?: Array<{ provider: ProviderId; path: string }>;
  /** Overridden in tests. */
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
}

export interface DiscoveryReport {
  roots: DiscoveryRoot[];
  /** Things the user may want to know about, shown on the Sources screen. */
  notes: string[];
}

/**
 * Candidate provider homes under one user home, for all providers.
 * `pathMod` lets WSL (POSIX) paths be joined with Windows separators when they
 * are reached over UNC, which is what `path.join` on win32 already does.
 */
function candidatesForHome(homeDir: string): Array<{ provider: ProviderId; path: string }> {
  const out: Array<{ provider: ProviderId; path: string }> = [];
  for (const adapter of ADAPTERS) {
    for (const name of adapter.homeDirNames) {
      out.push({ provider: adapter.id, path: path.join(homeDir, name) });
    }
  }
  return out;
}

/**
 * macOS-specific candidates. Both CLIs currently use `~/.codex` and `~/.claude`
 * on macOS exactly as on Linux, but Application Support is the conventional
 * place a future release could move to, so it is probed cheaply. Probing a
 * non-existent directory costs one `stat` and adds no root.
 */
function macOsCandidates(homeDir: string): Array<{ provider: ProviderId; path: string }> {
  const appSupport = path.join(homeDir, 'Library', 'Application Support');
  return [
    { provider: 'codex' as const, path: path.join(appSupport, 'Codex') },
    { provider: 'codex' as const, path: path.join(appSupport, 'codex') },
    { provider: 'claude-code' as const, path: path.join(appSupport, 'Claude Code') },
    { provider: 'claude-code' as const, path: path.join(appSupport, 'claude-code') },
  ];
}

export async function discoverRoots(options: DiscoveryOptions): Promise<DiscoveryReport> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const platform = options.platform ?? process.platform;

  const roots: DiscoveryRoot[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();

  const add = async (
    provider: ProviderId,
    host: HostRef,
    rootPath: string,
    origin: DiscoveryRoot['origin'],
  ): Promise<void> => {
    const normalized = path.normalize(rootPath);
    const key = `${provider}:${host.label}:${normalized.toLowerCase()}`;
    if (seen.has(key)) return;
    if (!(await directoryExists(normalized))) {
      if (origin === 'env' || origin === 'manual') {
        notes.push(`${provider}: configured root "${normalized}" does not exist`);
      }
      return;
    }
    seen.add(key);
    roots.push(makeRoot(provider, host, normalized, origin));
  };

  // 1. Environment overrides win, because a user who set them means it.
  for (const adapter of ADAPTERS) {
    if (!adapter.homeEnvVar) continue;
    const value = env[adapter.homeEnvVar];
    if (value && value.trim().length > 0) {
      await add(adapter.id, LOCAL_HOST, value.trim(), 'env');
      notes.push(`${adapter.displayName}: using ${adapter.homeEnvVar}`);
    }
  }

  // 2. Local home.
  for (const c of candidatesForHome(homeDir)) {
    await add(c.provider, LOCAL_HOST, c.path, 'default');
  }

  // 3. macOS conventional locations (cheap probe, usually adds nothing).
  if (platform === 'darwin') {
    for (const c of macOsCandidates(homeDir)) {
      await add(c.provider, LOCAL_HOST, c.path, 'default');
    }
  }

  // 4. WSL, Windows host only.
  if (platform === 'win32' && options.wslMode !== 'off') {
    const wsl = await discoverWslHomes(options.wslMode);
    for (const skip of wsl.skipped) {
      notes.push(`WSL "${skip.distro}" skipped: ${skip.reason}`);
    }
    for (const entry of wsl.homes) {
      for (const c of candidatesForHome(entry.home)) {
        await add(c.provider, wslHost(entry.distro), c.path, 'default');
      }
    }
    if (wsl.distros.length === 0) notes.push('No WSL distributions detected.');
  }

  // 5. Manual roots, the documented fallback when auto discovery finds nothing.
  for (const extra of options.extraRoots ?? []) {
    await add(extra.provider, LOCAL_HOST, extra.path, 'manual');
  }

  if (roots.length === 0) {
    notes.push(
      'No Codex or Claude Code data directories found. Add one manually in Settings if your logs live somewhere unusual.',
    );
  }

  return { roots, notes };
}
