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
 * The app is first bundled into one CommonJS file with esbuild (already present
 * as a transitive build dependency of Vite), because SEA cannot load a tree of
 * ES modules from disk.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
run(process.execPath, [
  path.join(root, 'node_modules', 'esbuild', 'bin', 'esbuild'),
  path.join(distDir, 'cli', 'sea-main.js'),
  '--bundle',
  '--platform=node',
  '--format=cjs',
  '--target=node20',
  `--outfile=${bundlePath}`,
  // `import.meta` does not exist in CommonJS output; the server detects that
  // and resolves its web assets relative to the executable instead.
  '--log-override:empty-import-meta=silent',
]);

console.log('• writing the SEA config');
// Web assets are read from disk next to the executable, so the release archive
// ships `dist/web/` alongside the binary rather than embedding megabytes of it.
const seaConfig = {
  main: bundlePath.replace(/\\/g, '/'),
  output: path.join(buildDir, 'sea-prep.blob').replace(/\\/g, '/'),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
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
console.log('  ship this next to dist/web/ — the UI assets are read from disk.');
