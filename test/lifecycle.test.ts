import http from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isAddressInUse,
  probeRunningInstance,
  watchWindow,
  WINDOW_CLOSED_GRACE_MS,
} from '../src/cli/lifecycle.js';

/**
 * These cover the two failures that made the packaged app look broken: a second
 * launch dying silently on a taken port, and the app never quitting because the
 * browser process had exited long before the window did.
 */

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

async function listen(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  return typeof address === 'object' && address ? address.port : 0;
}

describe('isAddressInUse', () => {
  it('recognises the error that a second launch hits', () => {
    const err: NodeJS.ErrnoException = new Error('listen EADDRINUSE');
    err.code = 'EADDRINUSE';
    expect(isAddressInUse(err)).toBe(true);
    expect(isAddressInUse(new Error('something else'))).toBe(false);
    expect(isAddressInUse(undefined)).toBe(false);
  });
});

describe('probeRunningInstance', () => {
  it('recognises another copy of this app', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ localOnly: true, version: '9.9.9', sessionCount: 3 }));
    });
    const found = await probeRunningInstance(port);
    expect(found).toEqual({ url: `http://127.0.0.1:${port}`, version: '9.9.9' });
  });

  it('does not mistake an unrelated service for one of ours', async () => {
    const jsonButNotUs = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ hello: 'world' }));
    });
    expect(await probeRunningInstance(jsonButNotUs)).toBeNull();

    const notJson = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>some other dev server</html>');
    });
    expect(await probeRunningInstance(notJson)).toBeNull();

    const errorStatus = await listen((_req, res) => {
      res.writeHead(500);
      res.end('nope');
    });
    expect(await probeRunningInstance(errorStatus)).toBeNull();
  });

  it('returns null rather than hanging when nothing is listening', async () => {
    // Port 1 is reserved and never bound by a user process.
    expect(await probeRunningInstance(1, 500)).toBeNull();
  });
});

describe('watchWindow', () => {
  it('quits once the window has been open and then goes away', () => {
    vi.useFakeTimers();
    try {
      const onClosed = vi.fn();
      const watch = watchWindow({ onClosed });

      watch.update(1); // window opened
      watch.update(0); // window closed
      expect(onClosed).not.toHaveBeenCalled();

      vi.advanceTimersByTime(WINDOW_CLOSED_GRACE_MS + 100);
      expect(onClosed).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('survives a page reload, which briefly looks exactly like a close', () => {
    vi.useFakeTimers();
    try {
      const onClosed = vi.fn();
      const watch = watchWindow({ onClosed });

      watch.update(1);
      watch.update(0);
      vi.advanceTimersByTime(WINDOW_CLOSED_GRACE_MS / 2);
      watch.update(1); // reconnected
      vi.advanceTimersByTime(WINDOW_CLOSED_GRACE_MS * 2);

      expect(onClosed).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not quit before the window has ever opened', () => {
    vi.useFakeTimers();
    try {
      const onClosed = vi.fn();
      watchWindow({ onClosed, openTimeoutMs: 60_000 });
      // A slow browser has not connected yet; zero clients is not a close.
      vi.advanceTimersByTime(30_000);
      expect(onClosed).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up if the window never appears, instead of leaving a server behind', () => {
    vi.useFakeTimers();
    try {
      const onClosed = vi.fn();
      watchWindow({ onClosed, openTimeoutMs: 5_000 });
      vi.advanceTimersByTime(6_000);
      expect(onClosed).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops firing once disposed', () => {
    vi.useFakeTimers();
    try {
      const onClosed = vi.fn();
      const watch = watchWindow({ onClosed });
      watch.update(1);
      watch.update(0);
      watch.dispose();
      vi.advanceTimersByTime(WINDOW_CLOSED_GRACE_MS * 3);
      expect(onClosed).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never fires twice for one close', () => {
    vi.useFakeTimers();
    try {
      const onClosed = vi.fn();
      const watch = watchWindow({ onClosed });
      watch.update(1);
      watch.update(0);
      watch.update(0); // duplicate notification
      vi.advanceTimersByTime(WINDOW_CLOSED_GRACE_MS * 3);
      expect(onClosed).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
