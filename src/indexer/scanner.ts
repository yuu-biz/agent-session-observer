import { DEFAULT_IDLE_THRESHOLD_MS } from '../core/activity.js';
import type { AppConfig } from '../core/config.js';
import { dedupeSessions } from '../core/dedupe.js';
import { buildSessionDetail, buildSessionSummary } from '../core/session-builder.js';
import { DAY_MS } from '../core/time.js';
import type {
  DiscoveryRoot,
  LiveMarker,
  NormalizedEvent,
  ParsedSession,
  ProviderAdapter,
  SessionDetail,
  SessionSummary,
} from '../core/types.js';
import { statFile } from '../discovery/fs-scan.js';
import { discoverRoots, getAdapter, type DiscoveryOptions } from '../discovery/roots.js';
import { ScanCache, type CachedFile } from './cache.js';

/**
 * Scanner
 * =======
 *
 * Walks every discovered root, parses what changed, and keeps normalized
 * session summaries in memory.
 *
 * Three properties matter more than raw speed:
 *  - a cold scan must not block the UI (the server serves partial results and
 *    streams progress);
 *  - a warm scan must touch only files whose size or mtime moved;
 *  - one broken file must never abort the scan.
 *
 * Detail views deliberately re-read the log rather than caching full event
 * lists: keeping 800 sessions' worth of prompts and tool arguments resident
 * would cost far more memory than it saves, and the file is already warm in the
 * OS cache.
 */

/** Cached events are stripped to what analysis needs, not what the UI shows. */
function compactEvents(events: readonly NormalizedEvent[]): NormalizedEvent[] {
  return events.map((e) => {
    const out: NormalizedEvent = { ts: e.ts, kind: e.kind };
    if (e.tokens) out.tokens = e.tokens;
    if (e.durationMs !== undefined) out.durationMs = e.durationMs;
    return out;
  });
}

function compactParsed(parsed: ParsedSession): ParsedSession {
  return { ...parsed, events: compactEvents(parsed.events), providerMeta: parsed.providerMeta };
}

export interface ScanProgress {
  phase: 'discovering' | 'listing' | 'parsing' | 'done';
  filesTotal: number;
  filesDone: number;
  sessions: number;
}

export interface ScanResult {
  sessions: SessionSummary[];
  duplicates: SessionSummary[];
  roots: DiscoveryRoot[];
  notes: string[];
  warnings: string[];
  scannedAt: number;
  durationMs: number;
  filesScanned: number;
  filesParsed: number;
}

export interface ScannerOptions {
  config: AppConfig;
  onProgress?: (p: ScanProgress) => void;
  /**
   * Overrides for root discovery. The server never sets these; tests use them
   * to pin `homeDir` / `platform` so a scan cannot wander into whatever Codex
   * or Claude Code happen to be installed on the machine running the suite.
   */
  discovery?: Partial<DiscoveryOptions>;
  /** Injected in tests. */
  now?: () => number;
}

const PARSE_CONCURRENCY = 8;

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}

interface FileTask {
  root: DiscoveryRoot;
  adapter: ProviderAdapter;
  filePath: string;
  size: number;
  mtimeMs: number;
}

export class SessionScanner {
  private cache: ScanCache | null = null;
  private sessions: SessionSummary[] = [];
  private duplicates: SessionSummary[] = [];
  private roots: DiscoveryRoot[] = [];
  /** sessionKey -> backing log file, for on-demand detail loading. */
  private sessionFiles = new Map<string, { filePath: string; provider: DiscoveryRoot['provider']; root: DiscoveryRoot }>();
  private lastResult: ScanResult | null = null;
  private scanning = false;

  constructor(private options: ScannerOptions) {}

  /**
   * Changing the idle threshold changes every derived figure, so the caller
   * follows this with a `scan()`. That is cheap: the cache holds the parsed
   * sessions, so no log file is re-read, only the analysis is redone.
   */
  updateConfig(config: AppConfig): void {
    this.options = { ...this.options, config };
  }

  getRoots(): readonly DiscoveryRoot[] {
    return this.roots;
  }

  get isScanning(): boolean {
    return this.scanning;
  }

  getSessions(): readonly SessionSummary[] {
    return this.sessions;
  }

  getDuplicates(): readonly SessionSummary[] {
    return this.duplicates;
  }

  getLastResult(): ScanResult | null {
    return this.lastResult;
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  async scan(): Promise<ScanResult> {
    if (this.scanning && this.lastResult) return this.lastResult;
    this.scanning = true;
    const started = this.now();
    const progress: ScanProgress = {
      phase: 'discovering',
      filesTotal: 0,
      filesDone: 0,
      sessions: 0,
    };
    const emit = (): void => this.options.onProgress?.({ ...progress });
    emit();

    try {
      const config = this.options.config;
      if (!this.cache) this.cache = await ScanCache.open();
      const cache = this.cache;

      const discovery = await discoverRoots({
        wslMode: config.wslMode,
        extraRoots: config.extraRoots,
        ...this.options.discovery,
      });
      this.roots = discovery.roots;

      progress.phase = 'listing';
      emit();

      const cutoff = started - config.lookbackDays * DAY_MS;
      const tasks: FileTask[] = [];
      const warnings: string[] = [];

      for (const root of discovery.roots) {
        const adapter = getAdapter(root.provider);
        let files: string[] = [];
        try {
          files = await adapter.listLogFiles(root.path);
        } catch (err) {
          warnings.push(`${root.id}: listing failed (${(err as Error).message})`);
          continue;
        }
        const stats = await mapLimit(files, 16, (f) => statFile(f));
        for (const st of stats) {
          if (!st) continue;
          // A file untouched since before the lookback window cannot contain
          // activity inside it, so it is skipped without being opened.
          if (st.mtimeMs < cutoff) continue;
          tasks.push({
            root,
            adapter,
            filePath: st.path,
            size: st.size,
            mtimeMs: st.mtimeMs,
          });
        }
      }

      progress.phase = 'parsing';
      progress.filesTotal = tasks.length;
      emit();

      // Runtime markers are collected once per root, not once per session.
      const markers = new Map<string, LiveMarker>();
      for (const root of discovery.roots) {
        const adapter = getAdapter(root.provider);
        if (!adapter.collectLiveMarkers) continue;
        try {
          for (const marker of await adapter.collectLiveMarkers(root.path)) {
            markers.set(`${root.provider}:${marker.sessionId}`, marker);
          }
        } catch {
          // Marker collection is opportunistic.
        }
      }

      let filesParsed = 0;
      const summaries: SessionSummary[] = [];
      const sessionFiles = new Map<string, { filePath: string; provider: DiscoveryRoot['provider']; root: DiscoveryRoot }>();

      await mapLimit(tasks, PARSE_CONCURRENCY, async (task) => {
        try {
          const cached = cache.get(task.filePath, task.size, task.mtimeMs);
          const unchanged =
            cached && cached.size === task.size && cached.mtimeMs === task.mtimeMs;

          let parsed: ParsedSession | null;
          if (unchanged) {
            parsed = cached.parsed;
          } else {
            filesParsed += 1;
            parsed = await task.adapter.parseFile({
              filePath: task.filePath,
              root: task.root,
              fromOffset: cached ? cached.bytesConsumed : 0,
              previous: cached ? cached.parsed : null,
            });
            if (parsed) {
              const entry: CachedFile = {
                filePath: task.filePath,
                size: task.size,
                mtimeMs: task.mtimeMs,
                bytesConsumed: parsed.bytesConsumed,
                parsed: compactParsed(parsed),
              };
              cache.set(entry);
            }
          }

          if (!parsed || parsed.events.length === 0) return;
          if (parsed.warnings.length > 0) warnings.push(...parsed.warnings.slice(0, 3));

          const summary = buildSessionSummary({
            parsed,
            root: task.root,
            filePath: task.filePath,
            fileSize: task.size,
            fileMtimeMs: task.mtimeMs,
            idleThresholdMs: this.options.config.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS,
            marker: markers.get(`${task.root.provider}:${parsed.sessionId}`),
            now: this.now(),
          });
          summaries.push(summary);
          sessionFiles.set(summary.key, {
            filePath: task.filePath,
            provider: task.root.provider,
            root: task.root,
          });
        } catch (err) {
          warnings.push(`${task.filePath}: ${(err as Error).message}`);
        } finally {
          progress.filesDone += 1;
          if (progress.filesDone % 25 === 0) {
            // Publish partial results during a cold scan so the dashboard fills
            // in as it goes instead of staying blank for the whole first run.
            const partial = dedupeSessions(summaries);
            this.sessions = partial.kept;
            this.duplicates = partial.duplicates;
            this.sessionFiles = new Map(sessionFiles);
            progress.sessions = partial.kept.length;
            emit();
          }
        }
      });

      const { kept, duplicates } = dedupeSessions(summaries);
      this.sessions = kept;
      this.duplicates = duplicates;
      this.sessionFiles = sessionFiles;

      cache.retainOnly(tasks.map((t) => t.filePath));
      await cache.flush();

      progress.phase = 'done';
      progress.sessions = kept.length;
      emit();

      const result: ScanResult = {
        sessions: kept,
        duplicates,
        roots: discovery.roots,
        notes: discovery.notes,
        warnings: warnings.slice(0, 200),
        scannedAt: started,
        durationMs: this.now() - started,
        filesScanned: tasks.length,
        filesParsed,
      };
      this.lastResult = result;
      return result;
    } finally {
      this.scanning = false;
    }
  }

  /** Re-reads one log file in full to build the detail view. */
  async loadDetail(sessionKey: string): Promise<SessionDetail | null> {
    const summary = this.sessions.find((s) => s.key === sessionKey);
    const location = this.sessionFiles.get(sessionKey);
    if (!summary || !location) return null;

    const adapter = getAdapter(location.provider);
    const parsed = await adapter.parseFile({
      filePath: location.filePath,
      root: location.root,
    });
    if (!parsed) return null;

    const st = await statFile(location.filePath);
    const rebuilt = buildSessionSummary({
      parsed,
      root: location.root,
      filePath: location.filePath,
      fileSize: st?.size ?? summary.fileSize,
      fileMtimeMs: st?.mtimeMs ?? summary.fileMtimeMs,
      idleThresholdMs: this.options.config.idleThresholdMs,
      now: this.now(),
    });
    return buildSessionDetail({ ...rebuilt, live: summary.live }, parsed.events);
  }
}
