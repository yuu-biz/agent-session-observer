#!/usr/bin/env node
/**
 * Builds a standalone executable using Node's Single Executable Application
 * support, so Windows users can run the dashboard without installing Node.
 *
 * Why SEA rather than a bundler-based packager: it needs no extra runtime
 * dependency beyond `postject` at build time, it embeds the official Node
 * binary this machine already trusts, and the output is reproducible from a
 * pinned Node version — which matters for a tool that reads private logs.
 *
 * The app is first bundled into one CommonJS file with esbuild, because SEA
 * cannot load a tree of ES modules from disk. The built UI is then embedded as
 * SEA assets, so the resulting binary is genuinely self-contained: one file to
 * copy, nothing beside it to keep in sync.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSync } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(root, 'build', 'sea');
const distDir = path.join(root, 'dist');
const outName = process.platform === 'win32' ? 'agent-session-observer.exe' : 'agent-session-observer';

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

function run(cmd, args, options = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...options });
}

rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });

console.log('• bundling the server into a single CommonJS file');
const bundlePath = path.join(buildDir, 'bundle.cjs');
// esbuild's JS API rather than its CLI: on Linux and macOS `bin/esbuild` is a
// native binary, so shelling out to it through `node` does not work.
buildSync({
  entryPoints: [path.join(distDir, 'cli', 'sea-main.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: bundlePath,
  // `import.meta` does not exist in CommonJS output; the server detects that
  // and resolves its web assets relative to the executable instead.
  logOverride: { 'empty-import-meta': 'silent' },
});

console.log('• collecting the UI assets to embed');
const webDir = path.join(distDir, 'web');

/** Every file under `dist/web`, keyed by the URL path it is served at. */
function collectAssets(dir, prefix = '') {
  const out = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const key = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, collectAssets(full, key));
    else if (entry.isFile()) out[`web/${key}`] = full.replace(/\\/g, '/');
  }
  return out;
}

let assets;
try {
  assets = collectAssets(webDir);
} catch {
  throw new Error(`no built UI at ${webDir} — run "npm run build" first`);
}
if (!assets['web/index.html']) {
  throw new Error(`no index.html under ${webDir} — run "npm run build" first`);
}
const assetBytes = Object.values(assets).reduce((sum, file) => sum + statSync(file).size, 0);
console.log(`  ${Object.keys(assets).length} files, ${(assetBytes / 1024).toFixed(0)} KB`);

console.log('• writing the SEA config');
const seaConfig = {
  main: bundlePath.replace(/\\/g, '/'),
  output: path.join(buildDir, 'sea-prep.blob').replace(/\\/g, '/'),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  // Embedding the UI is what makes the binary movable on its own.
  assets,
};
const configPath = path.join(buildDir, 'sea-config.json');
writeFileSync(configPath, JSON.stringify(seaConfig, null, 2), 'utf8');

console.log('• generating the SEA blob');
run(process.execPath, ['--experimental-sea-config', configPath]);

console.log('• copying the Node binary');
const exePath = path.join(buildDir, outName);
copyFileSync(process.execPath, exePath);

// On macOS the binary is signed, and injecting into a signed Mach-O invalidates
// the signature so hard that the OS refuses to run it. The signature has to be
// removed first and an ad-hoc one applied afterwards.
if (process.platform === 'darwin') {
  console.log('• removing the existing macOS signature');
  try {
    run('codesign', ['--remove-signature', exePath]);
  } catch {
    console.warn('  (no signature to remove)');
  }
}

console.log('• injecting the blob');
const postject = path.join(root, 'node_modules', 'postject', 'dist', 'cli.js');
const injectArgs = [
  postject,
  exePath,
  'NODE_SEA_BLOB',
  seaConfig.output,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
];
if (process.platform === 'darwin') injectArgs.push('--macho-segment-name', 'NODE_SEA');
run(process.execPath, injectArgs);

console.log(`\n✓ ${exePath}`);
console.log(`  node ${process.version}, agent-session-observer ${pkg.version}`);
console.log(
  `  self-contained: the UI is embedded, ${(statSync(exePath).size / 1048576).toFixed(0)} MB total.`,
);
