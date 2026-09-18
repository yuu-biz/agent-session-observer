#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CONFIG, loadConfig, type AppConfig } from '../core/config.js';
import {
  appProfileDir,
  findAppBrowser,
  hideConsoleWindow,
  launchAppWindow,
} from './app-window.js';
import { localTimeZoneName } from '../core/time.js';
import { discoverRoots } from '../discovery/roots.js';
import { startServer } from '../server/http.js';

export const VERSION = '0.1.2';

const HELP = `agent-session-observer ${VERSION}

Local-only dashboard for Codex CLI and Claude Code session activity.

Usage:
  agent-session-observer [options]

Options:
  --app             Open in a standalone app window instead of a browser tab.
                    Uses the Chromium browser you already have, hides the
                    console on Windows, and exits when the window is closed.
  --port <n>        Port to listen on (default 7781, 0 for any free port)
  --no-open         Do not open a browser
  --doctor          Print what was auto-discovered and exit
  --wsl <mode>      running | all | off   (default: running)
  --dev             Serve the API only; use the Vite dev server for the UI
  -h, --help        Show this help
  -v, --version     Show version

Everything stays on this machine: no telemetry, no network calls, and the
server listens on 127.0.0.1 only.
`;

interface CliArgs {
  port?: number;
  open: boolean;
  app: boolean;
  doctor: boolean;
  dev: boolean;
  wsl?: AppConfig['wslMode'];
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    open: true,
    app: false,
    doctor: false,
    dev: false,
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--port': {
        const value = Number(argv[i + 1]);
        if (Number.isInteger(value) && value >= 0 && value <= 65535) args.port = value;
        i += 1;
        break;
      }
      case '--no-open':
        args.open = false;
        break;
      case '--app':
        args.app = true;
        break;
      case '--doctor':
        args.doctor = true;
        break;
      case '--dev':
        args.dev = true;
        args.open = false;
        args.app = false;
        break;
      case '--wsl': {
        const value = argv[i + 1];
        if (value === 'running' || value === 'all' || value === 'off') args.wsl = value;
        i += 1;
        break;
      }
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '-v':
      case '--version':
        args.version = true;
        break;
      default:
        break;
    }
  }
  return args;
}

function openBrowser(url: string): void {
  const platform = process.platform;
  try {
    if (platform === 'win32') {
      // `start` is a cmd builtin; the empty title argument is required so that
      // a quoted URL is not mistaken for the window title.
      execFile('cmd', ['/c', 'start', '', url], { windowsHide: true });
    } else if (platform === 'darwin') {
      execFile('open', [url]);
    } else {
      execFile('xdg-open', [url]);
    }
  } catch {
    // Opening a browser is a convenience, never a requirement.
  }
}

async function runDoctor(config: AppConfig): Promise<void> {
  console.log(`agent-session-observer ${VERSION}`);
  console.log(`platform: ${process.platform}   timezone: ${localTimeZoneName()}`);
  console.log(`wsl mode: ${config.wslMode}   idle threshold: ${config.idleThresholdMs / 1000}s`);
  console.log('');

  const { roots, notes } = await discoverRoots({
    wslMode: config.wslMode,
    extraRoots: config.extraRoots,
  });

  if (roots.length === 0) console.log('No provider directories found.');
  for (const root of roots) {
    console.log(`  [${root.provider}] ${root.host.label}  ${root.path}   (${root.origin})`);
  }
  if (notes.length > 0) {
    console.log('');
    for (const note of notes) console.log(`  note: ${note}`);
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);

  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.version) {
    console.log(VERSION);
    return;
  }

  const stored = await loadConfig();
  const config: AppConfig = {
    ...DEFAULT_CONFIG,
    ...stored,
    ...(args.port !== undefined ? { port: args.port } : {}),
    ...(args.wsl !== undefined ? { wslMode: args.wsl } : {}),
  };

  if (args.doctor) {
    await runDoctor(config);
    return;
  }

  const handle = await startServer({ config, dev: args.dev, version: VERSION });

  const shutdown = (): void => {
    void handle.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const browser = args.app ? findAppBrowser() : null;

  console.log(`agent-session-observer ${VERSION}`);
  console.log(`  ${handle.url}`);
  console.log('  local only — no telemetry, no outbound requests');

  if (args.app && !browser) {
    console.log('  no Chromium-based browser found for --app; opening a normal tab instead');
  }

  if (browser) {
    console.log(`  app window via ${browser}`);
    console.log('  close the window to stop');
    // Hidden first so the console flashes for as little time as possible; the
    // lines above are still written for anyone capturing stdout to a pipe.
    hideConsoleWindow();
    const window = launchAppWindow(browser, handle.url, appProfileDir());
    window.closed.then(
      (userClosedIt) => {
        if (userClosedIt) shutdown();
      },
      () => undefined,
    );
    return;
  }

  console.log('  press Ctrl+C to stop');
  if (args.open) openBrowser(handle.url);
}

/** True when this file was run as the entry point rather than imported. */
function isEntryPoint(): boolean {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  void main().catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
}
