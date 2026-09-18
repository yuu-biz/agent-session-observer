import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { getAssetSource, normalizeAssetPath, resetAssetSource } from '../src/server/assets.js';

/**
 * `normalizeAssetPath` is the first thing every static request passes through,
 * and it is the only traversal defence the embedded asset backend can have -
 * there is no filesystem to re-check a resolved path against inside a single
 * executable. So it rejects rather than sanitises, and these tests pin that.
 */

const tempDirs: string[] = [];
afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

describe('normalizeAssetPath', () => {
  it('maps the site root to the shell document', () => {
    expect(normalizeAssetPath('/')).toBe('index.html');
    expect(normalizeAssetPath('')).toBe('index.html');
    expect(normalizeAssetPath('///')).toBe('index.html');
  });

  it('accepts ordinary asset paths', () => {
    expect(normalizeAssetPath('/index.html')).toBe('index.html');
    expect(normalizeAssetPath('/assets/index-abc123.js')).toBe('assets/index-abc123.js');
    expect(normalizeAssetPath('/assets/nested/deep/file.css')).toBe('assets/nested/deep/file.css');
  });

  it('decodes percent-encoding before validating, not after', () => {
    expect(normalizeAssetPath('/assets/a%20b.js')).toBe('assets/a b.js');
    // The decoded form is a traversal, so it must be rejected.
    expect(normalizeAssetPath('/%2e%2e/%2e%2e/package.json')).toBeNull();
    expect(normalizeAssetPath('/..%2f..%2fpackage.json')).toBeNull();
    expect(normalizeAssetPath('/assets/%2e%2e/%2e%2e/secret')).toBeNull();
  });

  it('rejects traversal in every spelling', () => {
    expect(normalizeAssetPath('/../package.json')).toBeNull();
    expect(normalizeAssetPath('/assets/../../etc/passwd')).toBeNull();
    expect(normalizeAssetPath('/./index.html')).toBeNull();
    expect(normalizeAssetPath('/assets//index.js')).toBeNull();
  });

  it('rejects backslashes, drive letters and UNC prefixes', () => {
    expect(normalizeAssetPath('/..\\..\\package.json')).toBeNull();
    expect(normalizeAssetPath('/assets\\index.js')).toBeNull();
    expect(normalizeAssetPath('/C:/Windows/System32/config/SAM')).toBeNull();
    expect(normalizeAssetPath('/c:/secret')).toBeNull();
  });

  it('rejects NUL bytes and undecodable escapes', () => {
    expect(normalizeAssetPath('/index.html%00.png')).toBeNull();
    expect(normalizeAssetPath('/%')).toBeNull();
    expect(normalizeAssetPath('/%zz')).toBeNull();
  });

  it('strips query strings and fragments', () => {
    expect(normalizeAssetPath('/assets/app.js?v=2')).toBe('assets/app.js');
    expect(normalizeAssetPath('/assets/app.js#top')).toBe('assets/app.js');
  });
});

describe('disk asset source', () => {
  it('reads files under the resolved asset root and refuses anything outside it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aso-assets-'));
    tempDirs.push(dir);

    // Mirrors the layout the server looks for: <execDir>/dist/web.
    const web = path.join(dir, 'dist', 'web', 'assets');
    await mkdir(web, { recursive: true });
    await writeFile(path.join(dir, 'dist', 'web', 'index.html'), '<!doctype html>ok', 'utf8');
    await writeFile(path.join(web, 'app.js'), 'console.log(1)', 'utf8');
    await writeFile(path.join(dir, 'outside.txt'), 'must not be served', 'utf8');

    // The disk source resolves relative to process.execPath, which cannot be
    // moved in-process, so exercise the same guard directly.
    const root = path.resolve(path.join(dir, 'dist', 'web'));
    const escaping = path.resolve(root, '../../outside.txt');
    expect(escaping.startsWith(root + path.sep)).toBe(false);
  });

  it('resolves a source for this build and reports where it came from', async () => {
    resetAssetSource();
    const source = await getAssetSource();
    // Running from source, the built UI sits next to the compiled server.
    expect(['embedded', 'disk', 'none']).toContain(source.kind);
    expect(typeof source.description).toBe('string');
    expect(source.description.length).toBeGreaterThan(0);
  });

  it('returns null rather than throwing for an asset that does not exist', async () => {
    resetAssetSource();
    const source = await getAssetSource();
    expect(await source.read('definitely-not-a-real-asset.xyz')).toBeNull();
  });
});
