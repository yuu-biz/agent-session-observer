import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { codexAdapter } from '../src/adapters/codex/index.js';
import { CODEX_ROOT, fakeRoot } from './helpers.js';

const root = fakeRoot('codex', CODEX_ROOT);

const MODERN = path.join(
  CODEX_ROOT,
  'sessions/2024/03/04/rollout-2024-03-04T09-00-00-11111111-1111-4111-8111-111111111111.jsonl',
);
const LEGACY = path.join(
  CODEX_ROOT,
  'sessions/2024/03/04/rollout-2024-03-04T10-00-00-22222222-2222-4222-8222-222222222222.jsonl',
);
const SUBAGENT = path.join(
  CODEX_ROOT,
  'sessions/2024/03/04/rollout-2024-03-04T11-00-00-33333333-3333-4333-8333-333333333333.jsonl',
);

describe('codex adapter: file discovery', () => {
  it('finds rollout files under sessions/YYYY/MM/DD', async () => {
    const files = await codexAdapter.listLogFiles(CODEX_ROOT);
    expect(files).toHaveLength(3);
    expect(files.every((f) => path.basename(f).startsWith('rollout-'))).toBe(true);
  });

  it('returns nothing for a directory that does not exist', async () => {
    const files = await codexAdapter.listLogFiles(path.join(CODEX_ROOT, 'does-not-exist'));
    expect(files).toEqual([]);
  });
});

describe('codex adapter: modern item_completed layout', () => {
  it('extracts session identity and metadata', async () => {
    const parsed = await codexAdapter.parseFile({ filePath: MODERN, root });
    expect(parsed).not.toBeNull();
    expect(parsed?.sessionId).toBe('11111111-1111-4111-8111-111111111111');
    expect(parsed?.cwd).toBe('/tmp/demo');
    expect(parsed?.gitBranch).toBe('main');
    expect(parsed?.cliVersion).toBe('0.150.0');
    expect(parsed?.models).toContain('demo-model-1');
  });

  it('maps items to normalized events without double counting channels', async () => {
    const parsed = await codexAdapter.parseFile({ filePath: MODERN, root });
    const prompts = parsed?.events.filter((e) => e.kind === 'user_prompt') ?? [];
    const tools = parsed?.events.filter((e) => e.kind === 'tool_call') ?? [];

    expect(prompts).toHaveLength(2);
    expect(prompts[0]?.summary).toBe('Add a health check endpoint.');
    // shell + file change + mcp + shell
    expect(tools).toHaveLength(4);
    expect(tools.map((t) => t.toolCategory)).toEqual(['shell', 'file_edit', 'mcp', 'shell']);
  });

  it('keeps provider-measured durations separate from estimates', async () => {
    const parsed = await codexAdapter.parseFile({ filePath: MODERN, root });
    // task_complete durations: 21000 + 30000
    expect(parsed?.measured.apiMs).toBe(51_000);
    // item durations: 2500 + 400 + 1000 + 1000
    expect(parsed?.measured.toolMs).toBe(4_900);
  });

  it('sums token usage from token_usage_record only', async () => {
    const parsed = await codexAdapter.parseFile({ filePath: MODERN, root });
    expect(parsed?.tokens).toEqual({
      input: 1200,
      output: 150,
      cacheRead: 400,
      cacheWrite: 0,
      reasoning: 40,
      total: 1350,
    });
  });
});

describe('codex adapter: legacy response_item layout', () => {
  it('parses tool calls and outputs', async () => {
    const parsed = await codexAdapter.parseFile({ filePath: LEGACY, root });
    expect(parsed?.sessionId).toBe('22222222-2222-4222-8222-222222222222');

    const tools = parsed?.events.filter((e) => e.kind === 'tool_call') ?? [];
    expect(tools.map((t) => t.toolName)).toEqual(['shell_command', 'apply_patch']);

    const results = parsed?.events.filter((e) => e.kind === 'tool_result') ?? [];
    // "Wall time: 2.5 seconds" and metadata.duration_seconds = 0.4
    expect(results.map((r) => r.durationMs)).toEqual([2500, 400]);
    expect(results.every((r) => r.exitCode === 0)).toBe(true);
  });

  it('skips malformed lines and a truncated tail without throwing', async () => {
    const parsed = await codexAdapter.parseFile({ filePath: LEGACY, root });
    expect(parsed).not.toBeNull();
    expect(parsed?.warnings.some((w) => w.includes('malformed'))).toBe(true);
    expect(parsed?.warnings.some((w) => w.includes('partial line'))).toBe(true);
  });

  it('reports bytesConsumed at a line boundary so a resume is safe', async () => {
    const parsed = await codexAdapter.parseFile({ filePath: LEGACY, root });
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(LEGACY);
    const consumed = parsed?.bytesConsumed ?? 0;
    expect(consumed).toBeLessThan(buf.length); // the partial tail was not consumed
    expect(buf[consumed - 1]).toBe(0x0a); // ends exactly after a newline
  });

  it('ignores record types it has never seen', async () => {
    const parsed = await codexAdapter.parseFile({ filePath: LEGACY, root });
    expect(parsed?.events.some((e) => e.subtype === 'something_new')).toBe(false);
  });
});

describe('codex adapter: subagent threads', () => {
  it('keeps its own identity when the parent session_meta is replayed', async () => {
    const parsed = await codexAdapter.parseFile({ filePath: SUBAGENT, root });
    expect(parsed?.sessionId).toBe('33333333-3333-4333-8333-333333333333');
    expect(parsed?.parentSessionId).toBe('11111111-1111-4111-8111-111111111111');
    expect(parsed?.isSubagent).toBe(true);
    expect(parsed?.agentLabel).toBe('reviewer');
  });
});
