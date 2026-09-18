import { promises as fs } from 'node:fs';
import path from 'node:path';

import { configDir } from '../core/config.js';
import type { ParsedSession } from '../core/types.js';

/**
 * On-disk scan cache.
 *
 * Two goals: a fast second start, and incremental re-parsing while the app is
 * open. Both providers write append-only JSONL, so remembering `bytesConsumed`
 * per file lets a growing log be resumed from the last complete line instead of
 * re-read from byte zero.
 *
 * What is cached is the *parsed session*, which contains prompt text. It is
 * written under the app's own directory with the same sensitivity as the source
 * logs, and never leaves the machine. Deleting the cache is always safe.
 */

export const CACHE_VERSION = 2;

export interface CachedFile {
  filePath: string;
  size: number;
  mtimeMs: number;
  bytesConsumed: number;
  parsed: ParsedSession;
}

interface CacheFileShape {
  version: number;
  updatedAt: number;
  files: CachedFile[];
}

export class ScanCache {
  private readonly entries = new Map<string, CachedFile>();
  private dirty = false;

  private constructor(private readonly filePath: string) {}

  static async open(fileName = 'scan-cache.json'): Promise<ScanCache> {
    const cache = new ScanCache(path.join(configDir(), fileName));
    await cache.load();
    return cache;
  }

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as CacheFileShape;
      if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.files)) return;
      for (const entry of parsed.files) {
        if (typeof entry?.filePath === 'string' && entry.parsed) {
          this.entries.set(entry.filePath, entry);
        }
      }
    } catch {
      // A missing or corrupt cache just means a cold scan.
    }
  }

  /**
   * Returns the cached parse when it is still usable.
   *
   * A file that shrank was truncated or replaced, so the cached offset is
   * meaningless and the entry is dropped — that is the case that would
   * otherwise produce silently wrong data.
   */
  get(filePath: string, size: number, mtimeMs: number): CachedFile | null {
    const entry = this.entries.get(filePath);
    if (!entry) return null;
    if (size < entry.size) {
      this.entries.delete(filePath);
      this.dirty = true;
      return null;
    }
    if (size === entry.size && mtimeMs === entry.mtimeMs) return entry;
    // Grown file: reusable as a resume point.
    return entry;
  }

  set(entry: CachedFile): void {
    this.entries.set(entry.filePath, entry);
    this.dirty = true;
  }

  /** Forgets files that no longer exist so the cache cannot grow forever. */
  retainOnly(livePaths: Iterable<string>): void {
    const keep = new Set(livePaths);
    for (const key of [...this.entries.keys()]) {
      if (!keep.has(key)) {
        this.entries.delete(key);
        this.dirty = true;
      }
    }
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    const payload: CacheFileShape = {
      version: CACHE_VERSION,
      updatedAt: Date.now(),
      files: [...this.entries.values()],
    };
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(payload), 'utf8');
      await fs.rename(tmp, this.filePath);
      this.dirty = false;
    } catch {
      // Cache persistence is best effort; failing to write must not break a scan.
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
