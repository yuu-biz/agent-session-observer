import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Bounded directory walking.
 *
 * Constraints that are not negotiable (see SECURITY.md):
 *  - never recurse into symlinks / junctions / reparse points, so a loop or a
 *    link into `C:\` cannot turn a log scan into a whole-disk scan;
 *  - never exceed `maxDepth`, so an unexpected layout cannot explode;
 *  - never scan a user's home directory recursively. Callers always pass a
 *    known provider subdirectory (`.codex/sessions`, `.claude/projects`).
 */

export interface ListOptions {
  /** Directory levels below `dir` to descend. `1` means "files in `dir`". */
  maxDepth: number;
  match: (fileName: string) => boolean;
  /** Safety valve against pathological trees. */
  maxEntries?: number;
}

export const DEFAULT_MAX_ENTRIES = 200_000;

export async function listFilesBounded(dir: string, options: ListOptions): Promise<string[]> {
  const out: string[] = [];
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const queue: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    if (item.depth >= options.maxDepth) continue;

    const key = path.resolve(item.dir).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    let entries;
    try {
      entries = await fs.readdir(item.dir, { withFileTypes: true });
    } catch {
      continue; // missing or unreadable directories are simply skipped
    }

    for (const entry of entries) {
      if (out.length >= maxEntries) return out;
      // Dirent.isSymbolicLink() is false for Windows junctions, so an explicit
      // lstat check is needed to refuse reparse points too.
      if (entry.isSymbolicLink()) continue;
      const full = path.join(item.dir, entry.name);
      if (entry.isDirectory()) {
        queue.push({ dir: full, depth: item.depth + 1 });
      } else if (entry.isFile() && options.match(entry.name)) {
        out.push(full);
      }
    }
  }
  return out;
}

export interface FileStat {
  path: string;
  size: number;
  mtimeMs: number;
}

/** `stat` that returns `null` instead of throwing for missing/locked files. */
export async function statFile(filePath: string): Promise<FileStat | null> {
  try {
    const st = await fs.lstat(filePath);
    if (!st.isFile()) return null;
    return { path: filePath, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

export async function directoryExists(dir: string): Promise<boolean> {
  try {
    const st = await fs.stat(dir);
    return st.isDirectory();
  } catch {
    return false;
  }
}
