import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * App-window mode.
 *
 * `--app` makes the dashboard behave like a desktop application without
 * shipping a second browser engine: it launches the Chromium-based browser the
 * user already has in "app" mode, which gives a window with no tab strip, no
 * address bar and its own taskbar entry.
 *
 * Two details make it feel like a real app rather than a browser trick:
 *
 *  - a dedicated `--user-data-dir`. Without it the browser hands the URL to an
 *    already-running instance and exits immediately, leaving us unable to tell
 *    when the window closes. With it, the spawned process *is* the window, so
 *    closing the window can shut the server down.
 *  - hiding the console window on Windows, because a console sitting behind the
 *    app is the thing that gives the game away.
 *
 * If no suitable browser is found, the caller falls back to opening a normal
 * browser tab. Nothing here is required for the app to work.
 */

/** Browsers that support `--app=`, most preferred first. */
const WINDOWS_CANDIDATES = [
  ['LOCALAPPDATA', 'Microsoft\\Edge\\Application\\msedge.exe'],
  ['PROGRAMFILES(X86)', 'Microsoft\\Edge\\Application\\msedge.exe'],
  ['PROGRAMFILES', 'Microsoft\\Edge\\Application\\msedge.exe'],
  ['LOCALAPPDATA', 'Google\\Chrome\\Application\\chrome.exe'],
  ['PROGRAMFILES', 'Google\\Chrome\\Application\\chrome.exe'],
  ['PROGRAMFILES(X86)', 'Google\\Chrome\\Application\\chrome.exe'],
  ['PROGRAMFILES', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
  ['LOCALAPPDATA', 'Vivaldi\\Application\\vivaldi.exe'],
] as const;

const MACOS_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
] as const;

const LINUX_CANDIDATES = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
  'brave-browser',
] as const;

function whichOnPath(command: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Locates a Chromium-based browser, or `null` when there is none to use. */
export function findAppBrowser(platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'win32') {
    for (const [envVar, relative] of WINDOWS_CANDIDATES) {
      const base = process.env[envVar];
      if (!base) continue;
      const full = path.join(base, relative);
      if (existsSync(full)) return full;
    }
    return null;
  }
  if (platform === 'darwin') {
    return MACOS_CANDIDATES.find((p) => existsSync(p)) ?? null;
  }
  for (const command of LINUX_CANDIDATES) {
    const found = whichOnPath(command);
    if (found) return found;
  }
  return null;
}

/** Profile directory for the app window, kept out of the user's own profile. */
export function appProfileDir(): string {
  const override = process.env.AGENT_SESSION_OBSERVER_HOME;
  const base = override && override.trim().length > 0
    ? path.resolve(override.trim())
    : path.join(os.homedir(), '.agent-session-observer');
  return path.join(base, 'app-window-profile');
}

export function appBrowserArgs(url: string, profileDir: string): string[] {
  return [
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,960',
    // The dashboard is a local page; none of this needs to phone home.
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
  ];
}

export interface AppWindow {
  child: ChildProcess;
  /** Resolves when the window closes, or `false` if it exited suspiciously fast. */
  closed: Promise<boolean>;
}

/**
 * A browser that delegates to an already-running instance exits within
 * milliseconds. Treating that as "the user closed the window" would shut the
 * server down the instant it started, so an exit this early is not trusted.
 */
export const DELEGATION_GRACE_MS = 3_000;

export function launchAppWindow(browser: string, url: string, profileDir: string): AppWindow {
  const startedAt = Date.now();
  const child = spawn(browser, appBrowserArgs(url, profileDir), {
    stdio: 'ignore',
    windowsHide: false,
  });

  const closed = new Promise<boolean>((resolve) => {
    child.once('exit', () => resolve(Date.now() - startedAt >= DELEGATION_GRACE_MS));
    child.once('error', () => resolve(false));
  });

  return { child, closed };
}

/**
 * Hides this process's console window on Windows.
 *
 * Node has no binding for `ShowWindow`, so a short PowerShell child does the
 * call. A child launched without a new console shares ours, which is why
 * `GetConsoleWindow()` there returns the very window we want to hide.
 *
 * Entirely best effort: if PowerShell is missing, restricted, or there is no
 * console at all (launched from a pipe, or from Explorer), nothing happens and
 * the app carries on with a visible console.
 */
export function hideConsoleWindow(): void {
  if (process.platform !== 'win32') return;

  const script = [
    "$sig = '[DllImport(\"kernel32.dll\")] public static extern IntPtr GetConsoleWindow();",
    '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);\'',
    '$t = Add-Type -MemberDefinition $sig -Name AsoConsole -Namespace Aso -PassThru',
    '$h = $t::GetConsoleWindow()',
    'if ($h -ne [IntPtr]::Zero) { [void]$t::ShowWindow($h, 0) }',
  ].join('\n');

  try {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 10_000, windowsHide: false },
      () => undefined,
    );
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // Never let a cosmetic step take the app down.
  }
}
