import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { clampIdleThreshold, DEFAULT_IDLE_THRESHOLD_MS } from './activity.js';
import type { ModelRate } from './pricing.js';
import type { ProviderId } from './types.js';

/**
 * Configuration is optional by design: the app must be useful with an empty
 * config file, and every field here has a working default. The file exists so
 * that auto discovery can be *corrected*, never so that it can be *required*.
 *
 * Stored under `~/.agent-session-observer/config.json`, well away from the
 * providers' own directories, which this app treats as strictly read-only.
 */

export type WslMode = 'running' | 'all' | 'off';

export interface AppConfig {
  /** Gap after which a session is considered idle rather than working. */
  idleThresholdMs: number;
  /** How WSL distributions are handled on Windows. */
  wslMode: WslMode;
  /** Extra provider homes, used when auto discovery misses a location. */
  extraRoots: Array<{ provider: ProviderId; path: string }>;
  /** Days of history loaded on startup. Older logs load on demand. */
  lookbackDays: number;
  /** Poll interval for picking up log changes while the app is open. */
  refreshIntervalMs: number;
  /** Port for the local HTTP server. 0 picks a free port. */
  port: number;
  /**
   * Overrides for the bundled price list, in USD per 1,000,000 tokens. The key
   * is matched against the model id exactly as `pricing.ts` matches its own
   * entries, so `"gpt-5"` reprices a family and `"gpt-5-codex"` one model.
   *
   * This exists because list prices are the wrong number for most
   * organisations: committed-use discounts, resold capacity and flat-rate
   * seats all produce a different cost per token, and a cost figure nobody
   * recognises is worse than none.
   */
  modelRates: Record<string, Partial<ModelRate>>;
}

export const DEFAULT_CONFIG: AppConfig = {
  idleThresholdMs: DEFAULT_IDLE_THRESHOLD_MS,
  wslMode: 'running',
  extraRoots: [],
  lookbackDays: 30,
  refreshIntervalMs: 5_000,
  port: 7781,
  modelRates: {},
};

export function configDir(): string {
  const override = process.env.AGENT_SESSION_OBSERVER_HOME;
  if (override && override.trim().length > 0) return path.resolve(override.trim());
  return path.join(os.homedir(), '.agent-session-observer');
}

export function configPath(): string {
  return path.join(configDir(), 'config.json');
}

function isProviderId(value: unknown): value is ProviderId {
  return value === 'codex' || value === 'claude-code';
}

/** Validates and clamps untrusted JSON into an `AppConfig`. */
export function normalizeConfig(raw: unknown): AppConfig {
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const wslMode = obj.wslMode;

  const extraRoots: AppConfig['extraRoots'] = [];
  if (Array.isArray(obj.extraRoots)) {
    for (const entry of obj.extraRoots) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (isProviderId(e.provider) && typeof e.path === 'string' && e.path.trim().length > 0) {
        extraRoots.push({ provider: e.provider, path: e.path.trim() });
      }
    }
  }

  const lookbackDays =
    typeof obj.lookbackDays === 'number' && Number.isFinite(obj.lookbackDays)
      ? Math.min(3650, Math.max(1, Math.round(obj.lookbackDays)))
      : DEFAULT_CONFIG.lookbackDays;

  const refreshIntervalMs =
    typeof obj.refreshIntervalMs === 'number' && Number.isFinite(obj.refreshIntervalMs)
      ? Math.min(600_000, Math.max(1_000, Math.round(obj.refreshIntervalMs)))
      : DEFAULT_CONFIG.refreshIntervalMs;

  const modelRates: AppConfig['modelRates'] = {};
  const rawRates = obj.modelRates;
  if (typeof rawRates === 'object' && rawRates !== null && !Array.isArray(rawRates)) {
    for (const [model, value] of Object.entries(rawRates as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const v = value as Record<string, unknown>;
      const rate: Partial<ModelRate> = {};
      for (const field of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
        const n = v[field];
        // A negative or non-finite price would silently corrupt every total
        // downstream, so it is dropped rather than clamped.
        if (typeof n === 'number' && Number.isFinite(n) && n >= 0) rate[field] = n;
      }
      if (Object.keys(rate).length > 0) modelRates[model.trim().toLowerCase()] = rate;
    }
  }

  const port =
    typeof obj.port === 'number' && Number.isInteger(obj.port) && obj.port >= 0 && obj.port <= 65535
      ? obj.port
      : DEFAULT_CONFIG.port;

  return {
    idleThresholdMs: clampIdleThreshold(
      typeof obj.idleThresholdMs === 'number' ? obj.idleThresholdMs : DEFAULT_CONFIG.idleThresholdMs,
    ),
    wslMode: wslMode === 'all' || wslMode === 'off' || wslMode === 'running' ? wslMode : DEFAULT_CONFIG.wslMode,
    extraRoots,
    lookbackDays,
    refreshIntervalMs,
    port,
    modelRates,
  };
}

export async function loadConfig(): Promise<AppConfig> {
  try {
    const raw = await fs.readFile(configPath(), 'utf8');
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(config: AppConfig): Promise<void> {
  const dir = configDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(configPath(), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
