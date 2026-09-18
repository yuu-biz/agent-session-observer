import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { listFilesBounded, directoryExists, statFile } from '../src/discovery/fs-scan.js';
import { isPidAlive } from '../src/discovery/process.js';
import { discoverRoots } from '../src/discovery/roots.js';
import { CLAUDE_ROOT, CODEX_ROOT } from './helpers.js';

const tempDirs: string[] = [];
afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aso-disc-'));
  tempDirs.push(dir);
  return dir;
}

describe('bounded filesystem scanning', () => {
  it('respects maxDepth', async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, 'a', 'b', 'c'), { recursive: true });
    await writeFile(path.join(dir, 'top.jsonl'), '', 'utf8');
    await writeFile(path.join(dir, 'a', 'one.jsonl'), '', 'utf8');
    await writeFile(path.join(dir, 'a', 'b', 'two.jsonl'), '', 'utf8');
    await writeFile(path.join(dir, 'a', 'b', 'c', 'three.jsonl'), '', 'utf8');

    const match = (n: string): boolean => n.endsWith('.jsonl');
    expect(await listFilesBounded(dir, { maxDepth: 1, match })).toHaveLength(1);
    expect(await listFilesBounded(dir, { maxDepth: 2, match })).toHaveLength(2);
    expect(await listFilesBounded(dir, { maxDepth: 4, match })).toHaveLength(4);
  });

  it('never follows a symlink, so a loop cannot turn into a whole-disk scan', async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, 'real'), { recursive: true });
    await writeFile(path.join(dir, 'real', 'a.jsonl'), '', 'utf8');

    let linked = false;
    try {
      await symlink(path.join(dir, 'real'), path.join(dir, 'loop'), 'dir');
      linked = true;
    } catch {
      // Creating symlinks on Windows needs privileges; skip if unavailable.
    }

    const files = await listFilesBounded(dir, { maxDepth: 5, match: (n) => n.endsWith('.jsonl') });
    expect(files).toHaveLength(1);
    if (linked) expect(files.every((f) => !f.includes(`${path.sep}loop${path.sep}`))).toBe(true);
  });

  it('returns an empty list for a missing directory rather than throwing', async () => {
    const files = await listFilesBounded(path.join(await tempDir(), 'nope'), {
      maxDepth: 3,
      match: () => true,
    });
    expect(files).toEqual([]);
  });

  it('honours maxEntries as a safety valve', async () => {
    const dir = await tempDir();
    for (let i = 0; i < 20; i += 1) await writeFile(path.join(dir, `f${i}.jsonl`), '', 'utf8');
    const files = await listFilesBounded(dir, {
      maxDepth: 1,
      match: () => true,
      maxEntries: 5,
    });
    expect(files.length).toBeLessThanOrEqual(5);
  });
});

describe('stat helpers', () => {
  it('returns null for a missing file instead of throwing', async () => {
    expect(await statFile(path.join(await tempDir(), 'missing'))).toBeNull();
  });

  it('reports size and mtime for a real file', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'x.jsonl');
    await writeFile(file, 'hello', 'utf8');
    const st = await statFile(file);
    expect(st?.size).toBe(5);
    expect(st?.mtimeMs).toBeGreaterThan(0);
  });

  it('distinguishes directories from files', async () => {
    const dir = await tempDir();
    expect(await directoryExists(dir)).toBe(true);
    expect(await directoryExists(path.join(dir, 'nope'))).toBe(false);
    expect(await statFile(dir)).toBeNull();
  });
});

describe('pid liveness', () => {
  it('knows this process is alive and that pid 0 is not a real pid', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(0)).toBeUndefined();
    expect(isPidAlive(-1)).toBeUndefined();
  });
});

describe('root discovery', () => {
  it('finds provider homes under a simulated Windows profile', async () => {
    const home = await tempDir();
    await mkdir(path.join(home, '.codex'), { recursive: true });
    await mkdir(path.join(home, '.claude'), { recursive: true });

    const { roots } = await discoverRoots({
      wslMode: 'off',
      homeDir: home,
      platform: 'win32',
      env: {},
    });

    expect(roots.map((r) => r.provider).sort()).toEqual(['claude-code', 'codex']);
    expect(roots.every((r) => r.host.kind === 'local')).toBe(true);
    expect(roots.every((r) => r.origin === 'default')).toBe(true);
  });

  it('does not invent roots for directories that do not exist', async () => {
    const home = await tempDir();
    const { roots, notes } = await discoverRoots({
      wslMode: 'off',
      homeDir: home,
      platform: 'win32',
      env: {},
    });
    expect(roots).toEqual([]);
    expect(notes.join(' ')).toContain('No Codex or Claude Code data directories found');
  });

  it('prefers CODEX_HOME and CLAUDE_CONFIG_DIR when they are set', async () => {
    const home = await tempDir();
    const custom = await tempDir();
    await mkdir(path.join(custom, 'codex-home'), { recursive: true });
    await mkdir(path.join(custom, 'claude-home'), { recursive: true });

    const { roots, notes } = await discoverRoots({
      wslMode: 'off',
      homeDir: home,
      platform: 'linux',
      env: {
        CODEX_HOME: path.join(custom, 'codex-home'),
        CLAUDE_CONFIG_DIR: path.join(custom, 'claude-home'),
      },
    });

    expect(roots).toHaveLength(2);
    expect(roots.every((r) => r.origin === 'env')).toBe(true);
    expect(notes.join(' ')).toContain('CODEX_HOME');
  });

  it('warns when a configured root does not exist, and skips it', async () => {
    const home = await tempDir();
    const { roots, notes } = await discoverRoots({
      wslMode: 'off',
      homeDir: home,
      platform: 'darwin',
      env: { CODEX_HOME: path.join(home, 'nowhere') },
    });
    expect(roots).toEqual([]);
    expect(notes.some((n) => n.includes('does not exist'))).toBe(true);
  });

  it('accepts manually configured extra roots', async () => {
    const home = await tempDir();
    const { roots } = await discoverRoots({
      wslMode: 'off',
      homeDir: home,
      platform: 'linux',
      env: {},
      extraRoots: [
        { provider: 'codex', path: CODEX_ROOT },
        { provider: 'claude-code', path: CLAUDE_ROOT },
      ],
    });
    expect(roots).toHaveLength(2);
    expect(roots.every((r) => r.origin === 'manual')).toBe(true);
  });

  it('deduplicates a root reached through two different sources', async () => {
    const home = await tempDir();
    await mkdir(path.join(home, '.codex'), { recursive: true });
    const { roots } = await discoverRoots({
      wslMode: 'off',
      homeDir: home,
      platform: 'linux',
      env: {},
      extraRoots: [{ provider: 'codex', path: path.join(home, '.codex') }],
    });
    expect(roots).toHaveLength(1);
  });

  it('never looks for WSL on a non-Windows host', async () => {
    const home = await tempDir();
    await mkdir(path.join(home, '.codex'), { recursive: true });
    const { roots, notes } = await discoverRoots({
      wslMode: 'all',
      homeDir: home,
      platform: 'linux',
      env: {},
    });
    expect(roots.every((r) => r.host.kind === 'local')).toBe(true);
    expect(notes.some((n) => n.toLowerCase().includes('wsl'))).toBe(false);
  });

  it('probes macOS Application Support locations without inventing roots', async () => {
    const home = await tempDir();
    await mkdir(path.join(home, 'Library', 'Application Support', 'Codex'), { recursive: true });
    const { roots } = await discoverRoots({
      wslMode: 'off',
      homeDir: home,
      platform: 'darwin',
      env: {},
    });
    expect(roots).toHaveLength(1);
    expect(roots[0]?.provider).toBe('codex');
    expect(roots[0]?.path).toContain('Application Support');
  });
});
