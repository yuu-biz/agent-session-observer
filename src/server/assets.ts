import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Static asset resolution.
 *
 * The dashboard has to load in two very different shapes:
 *
 *   - installed from source, where the built UI sits on disk next to the
 *     compiled server (`dist/web/`);
 *   - as a single executable, where the UI is embedded in the binary itself so
 *     that the file can be moved anywhere and still work.
 *
 * Both are served through the same interface, so `http.ts` never has to care
 * which one it is running as. Embedded assets are tried first: if the binary
 * carries a UI, that is the UI it should serve, not whatever happens to be in
 * the working directory.
 */

export interface StaticAsset {
  data: Buffer;
  /** Path the asset was resolved at, for diagnostics. */
  source: string;
}

export interface AssetSource {
  readonly kind: 'embedded' | 'disk' | 'none';
  /** Human readable location, shown by `--doctor`. */
  readonly description: string;
  read(relPath: string): Promise<StaticAsset | null>;
}

/** Keys inside the executable are prefixed so they cannot collide with data. */
export const EMBEDDED_PREFIX = 'web/';

/**
 * Normalizes a URL path into a safe relative asset path.
 *
 * Returns `null` for anything that escapes the asset root. This runs before
 * either backend sees the path, so traversal is rejected identically whether
 * the assets live on disk or inside the binary.
 */
export function normalizeAssetPath(urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }

  const trimmed = decoded.split('?')[0]?.split('#')[0] ?? '';
  const withoutLeadingSlashes = trimmed.replace(/^\/+/, '');
  if (withoutLeadingSlashes === '') return 'index.html';

  // Reject anything containing a traversal or a drive/UNC prefix outright,
  // rather than trying to sanitise it into something safe.
  if (/\\/.test(withoutLeadingSlashes)) return null;
  if (/^[a-zA-Z]:/.test(withoutLeadingSlashes)) return null;

  const segments = withoutLeadingSlashes.split('/');
  for (const segment of segments) {
    if (segment === '..' || segment === '.' || segment === '') return null;
    if (segment.includes('\0')) return null;
  }
  return segments.join('/');
}

/** Reads the UI out of the running single-executable build. */
async function createEmbeddedSource(): Promise<AssetSource | null> {
  let sea: {
    isSea(): boolean;
    getRawAsset(key: string): ArrayBuffer;
  };
  try {
    // `node:sea` only exists on Node 20.12+, and dynamic import keeps older
    // runtimes on the disk path instead of failing at startup.
    sea = (await import('node:sea')) as unknown as typeof sea;
  } catch {
    return null;
  }

  try {
    if (!sea.isSea()) return null;
    // Probe the one asset that must exist; its absence means this executable
    // was built without an embedded UI.
    sea.getRawAsset(`${EMBEDDED_PREFIX}index.html`);
  } catch {
    return null;
  }

  return {
    kind: 'embedded',
    description: 'embedded in the executable',
    async read(relPath: string): Promise<StaticAsset | null> {
      try {
        const raw = sea.getRawAsset(EMBEDDED_PREFIX + relPath);
        return { data: Buffer.from(raw), source: `sea:${EMBEDDED_PREFIX}${relPath}` };
      } catch {
        return null;
      }
    },
  };
}

/**
 * Candidate directories for an on-disk UI: beside the compiled server for a
 * normal install, then beside the executable.
 */
function diskCandidates(): string[] {
  const candidates: string[] = [];
  try {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.join(moduleDir, '..', 'web'));
  } catch {
    // Bundled into a single executable; `import.meta` is not available.
  }
  const execDir = path.dirname(process.execPath);
  candidates.push(path.join(execDir, 'dist', 'web'), path.join(execDir, 'web'));
  return candidates;
}

async function createDiskSource(): Promise<AssetSource | null> {
  for (const dir of diskCandidates()) {
    const root = path.resolve(dir);
    try {
      await fs.access(path.join(root, 'index.html'));
    } catch {
      continue;
    }
    return {
      kind: 'disk',
      description: root,
      async read(relPath: string): Promise<StaticAsset | null> {
        const resolved = path.resolve(root, relPath);
        // Re-check after resolution: the belt to normalizeAssetPath's braces.
        if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
        try {
          const data = await fs.readFile(resolved);
          return { data, source: resolved };
        } catch {
          return null;
        }
      },
    };
  }
  return null;
}

const NO_ASSETS: AssetSource = {
  kind: 'none',
  description: 'no UI assets found',
  async read(): Promise<StaticAsset | null> {
    return null;
  },
};

let cached: Promise<AssetSource> | null = null;

/** Resolves the asset source once per process. */
export function getAssetSource(): Promise<AssetSource> {
  cached ??= (async () => (await createEmbeddedSource()) ?? (await createDiskSource()) ?? NO_ASSETS)();
  return cached;
}

/** Test seam: forgets the cached source. */
export function resetAssetSource(): void {
  cached = null;
}
