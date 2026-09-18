import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { claudeCodeAdapter } from '../src/adapters/claude-code/index.js';
import { codexAdapter } from '../src/adapters/codex/index.js';
import { readJsonl } from '../src/core/jsonl.js';
import { fakeRoot } from './helpers.js';

/**
 * Incremental parsing is the mechanism that lets the dashboard follow a live
 * session without re-reading a growing log from byte zero. It is only correct
 * if `bytesConsumed` always lands on a line boundary, so these tests append to
 * a file the way an agent would — including mid-line — and check that resuming
 * yields exactly the same result as a full re-read.
 */

const tempDirs: string[] = [];
afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aso-incr-'));
  tempDirs.push(dir);
  return dir;
}

function codexUserItem(ts: string, text: string): string {
  return JSON.stringify({
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: 'tid',
      turn_id: 'turn-1',
      item: { type: 'UserMessage', id: `i-${ts}`, content: [{ type: 'text', text }] },
    },
  });
}

function codexMeta(id: string): string {
  return JSON.stringify({
    timestamp: '2024-03-04T09:00:00.000Z',
    type: 'session_meta',
    payload: { session_id: id, id, cwd: '/tmp/x', cli_version: '0.150.0', model_provider: 'openai' },
  });
}

describe('readJsonl byte accounting', () => {
  it('reports only complete lines as consumed', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'a.jsonl');
    await writeFile(file, '{"a":1}\n{"b":2}\n{"c":', 'utf8');

    const seen: unknown[] = [];
    const result = await readJsonl(file, (line) => void seen.push(line.value));

    expect(seen).toEqual([{ a: 1 }, { b: 2 }]);
    expect(result.bytesConsumed).toBe(16); // the two complete lines
    expect(result.trailingPartial).toBe(true);
  });

  it('resumes from an offset without re-reading earlier lines', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'b.jsonl');
    await writeFile(file, '{"a":1}\n{"b":2}\n', 'utf8');
    const first = await readJsonl(file, () => undefined);

    await appendFile(file, '{"c":3}\n', 'utf8');
    const seen: unknown[] = [];
    await readJsonl(file, (line) => void seen.push(line.value), { fromOffset: first.bytesConsumed });

    expect(seen).toEqual([{ c: 3 }]);
  });

  it('handles CRLF line endings identically to LF', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'crlf.jsonl');
    await writeFile(file, '{"a":1}\r\n{"b":2}\r\n', 'utf8');
    const seen: unknown[] = [];
    const result = await readJsonl(file, (line) => void seen.push(line.value));
    expect(seen).toEqual([{ a: 1 }, { b: 2 }]);
    expect(result.trailingPartial).toBe(false);
  });

  it('reads UTF-8 correctly regardless of the host console encoding', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'utf8.jsonl');
    await writeFile(file, `${JSON.stringify({ text: 'テスト — ünïcodé 🚀' })}\n`, 'utf8');
    let value: unknown = null;
    await readJsonl(file, (line) => {
      value = line.value;
    });
    expect(value).toEqual({ text: 'テスト — ünïcodé 🚀' });
  });

  it('does not split a multi-byte character across chunk boundaries', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'big.jsonl');
    // Large enough to span several read chunks.
    const lines = Array.from({ length: 400 }, (_, i) => JSON.stringify({ i, s: '日本語テキスト'.repeat(60) }));
    await writeFile(file, `${lines.join('\n')}\n`, 'utf8');

    let count = 0;
    let bad = 0;
    await readJsonl(file, (line) => {
      count += 1;
      if (line.value === null) bad += 1;
    });
    expect(count).toBe(400);
    expect(bad).toBe(0);
  });

  it('stops early when the callback returns false', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'stop.jsonl');
    await writeFile(file, '{"a":1}\n{"b":2}\n{"c":3}\n', 'utf8');
    let count = 0;
    await readJsonl(file, () => {
      count += 1;
      return count < 2;
    });
    expect(count).toBe(2);
  });
});

describe('codex incremental parsing', () => {
  it('appending events yields the same result as a full re-read', async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, 'sessions', '2024', '03', '04'), { recursive: true });
    const file = path.join(
      dir,
      'sessions/2024/03/04/rollout-2024-03-04T09-00-00-abcdef01-2345-4678-9abc-def012345678.jsonl',
    );
    const root = fakeRoot('codex', dir);

    await writeFile(
      file,
      `${codexMeta('abcdef01-2345-4678-9abc-def012345678')}\n${codexUserItem('2024-03-04T09:00:01.000Z', 'first')}\n`,
      'utf8',
    );
    const first = await codexAdapter.parseFile({ filePath: file, root });
    expect(first?.events.filter((e) => e.kind === 'user_prompt')).toHaveLength(1);

    await appendFile(file, `${codexUserItem('2024-03-04T09:05:00.000Z', 'second')}\n`, 'utf8');

    const incremental = await codexAdapter.parseFile({
      filePath: file,
      root,
      fromOffset: first?.bytesConsumed ?? 0,
      previous: first,
    });
    const full = await codexAdapter.parseFile({ filePath: file, root });

    expect(incremental?.events.map((e) => [e.ts, e.kind, e.summary])).toEqual(
      full?.events.map((e) => [e.ts, e.kind, e.summary]),
    );
    expect(incremental?.sessionId).toBe(full?.sessionId);
  });

  it('resumes correctly when the previous read stopped at a partial line', async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, 'sessions', '2024', '03', '04'), { recursive: true });
    const file = path.join(
      dir,
      'sessions/2024/03/04/rollout-2024-03-04T09-00-00-abcdef01-2345-4678-9abc-def012345678.jsonl',
    );
    const root = fakeRoot('codex', dir);

    const halfLine = codexUserItem('2024-03-04T09:05:00.000Z', 'second');
    await writeFile(
      file,
      `${codexMeta('abcdef01-2345-4678-9abc-def012345678')}\n${codexUserItem('2024-03-04T09:00:01.000Z', 'first')}\n${halfLine.slice(0, 40)}`,
      'utf8',
    );
    const first = await codexAdapter.parseFile({ filePath: file, root });
    expect(first?.events.filter((e) => e.kind === 'user_prompt')).toHaveLength(1);

    // The agent finishes writing the line it had started.
    await appendFile(file, `${halfLine.slice(40)}\n`, 'utf8');

    const resumed = await codexAdapter.parseFile({
      filePath: file,
      root,
      fromOffset: first?.bytesConsumed ?? 0,
      previous: first,
    });
    expect(resumed?.events.filter((e) => e.kind === 'user_prompt')).toHaveLength(2);
  });

  it('accumulates measured durations across incremental reads without double counting', async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, 'sessions', '2024', '03', '04'), { recursive: true });
    const file = path.join(
      dir,
      'sessions/2024/03/04/rollout-2024-03-04T09-00-00-abcdef01-2345-4678-9abc-def012345678.jsonl',
    );
    const root = fakeRoot('codex', dir);
    const done = (ts: string, ms: number): string =>
      JSON.stringify({
        timestamp: ts,
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 't', duration_ms: ms },
      });

    await writeFile(
      file,
      `${codexMeta('abcdef01-2345-4678-9abc-def012345678')}\n${done('2024-03-04T09:00:10.000Z', 1000)}\n`,
      'utf8',
    );
    const first = await codexAdapter.parseFile({ filePath: file, root });
    expect(first?.measured.apiMs).toBe(1000);

    await appendFile(file, `${done('2024-03-04T09:00:20.000Z', 2500)}\n`, 'utf8');
    const second = await codexAdapter.parseFile({
      filePath: file,
      root,
      fromOffset: first?.bytesConsumed ?? 0,
      previous: first,
    });
    expect(second?.measured.apiMs).toBe(3500);
  });
});

describe('claude code incremental parsing', () => {
  it('appending a turn yields the same result as a full re-read', async () => {
    const dir = await tempDir();
    const projects = path.join(dir, 'projects', '-tmp-x');
    await mkdir(projects, { recursive: true });
    const file = path.join(projects, 'sess-1.jsonl');
    const root = fakeRoot('claude-code', dir);

    const user = (ts: string, text: string, uuid: string): string =>
      JSON.stringify({
        type: 'user',
        sessionId: 'sess-1',
        uuid,
        cwd: '/tmp/x',
        timestamp: ts,
        message: { role: 'user', content: text },
      });

    await writeFile(file, `${user('2024-03-04T09:00:00.000Z', 'hello', 'u1')}\n`, 'utf8');
    const first = await claudeCodeAdapter.parseFile({ filePath: file, root });

    await appendFile(file, `${user('2024-03-04T09:01:00.000Z', 'again', 'u2')}\n`, 'utf8');
    const incremental = await claudeCodeAdapter.parseFile({
      filePath: file,
      root,
      fromOffset: first?.bytesConsumed ?? 0,
      previous: first,
    });
    const full = await claudeCodeAdapter.parseFile({ filePath: file, root });

    expect(incremental?.events.map((e) => [e.ts, e.kind, e.summary])).toEqual(
      full?.events.map((e) => [e.ts, e.kind, e.summary]),
    );
  });

  it('takes the latest cost-state snapshot rather than summing snapshots', async () => {
    const dir = await tempDir();
    const projects = path.join(dir, 'projects', '-tmp-x');
    await mkdir(projects, { recursive: true });
    const file = path.join(projects, 'sess-2.jsonl');
    const root = fakeRoot('claude-code', dir);

    const cost = (usd: number, api: number): string =>
      JSON.stringify({
        type: 'cost-state',
        sessionId: 'sess-2',
        totalCostUSD: usd,
        totalAPIDuration: api,
        totalToolDuration: 0,
        totalDuration: 0,
        modelUsage: {},
      });

    await writeFile(
      file,
      `${JSON.stringify({
        type: 'user',
        sessionId: 'sess-2',
        uuid: 'u1',
        timestamp: '2024-03-04T09:00:00.000Z',
        message: { role: 'user', content: 'hi' },
      })}\n${cost(1, 1000)}\n`,
      'utf8',
    );
    const first = await claudeCodeAdapter.parseFile({ filePath: file, root });
    expect(first?.costUsd).toBe(1);

    await appendFile(file, `${cost(3, 5000)}\n`, 'utf8');
    const second = await claudeCodeAdapter.parseFile({
      filePath: file,
      root,
      fromOffset: first?.bytesConsumed ?? 0,
      previous: first,
    });
    expect(second?.costUsd).toBe(3);
    expect(second?.measured.apiMs).toBe(5000);
  });
});
