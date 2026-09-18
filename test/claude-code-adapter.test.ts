import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { claudeCodeAdapter, detectSubagent } from '../src/adapters/claude-code/index.js';
import { CLAUDE_ROOT, fakeRoot } from './helpers.js';

const root = fakeRoot('claude-code', CLAUDE_ROOT);
const PROJECT = path.join(CLAUDE_ROOT, 'projects', '-tmp-demo');
const SESSION = path.join(PROJECT, 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa.jsonl');
const SUBAGENT = path.join(PROJECT, 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'subagents', 'agent-demo.jsonl');

const tempDirs: string[] = [];
afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aso-test-'));
  tempDirs.push(dir);
  return dir;
}

describe('claude code adapter: file discovery', () => {
  it('finds session and subagent transcripts but skips .orphaned- files', async () => {
    const files = await claudeCodeAdapter.listLogFiles(CLAUDE_ROOT);
    const names = files.map((f) => path.basename(f)).sort();
    expect(names).toEqual(['aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa.jsonl', 'agent-demo.jsonl']);
    expect(files.some((f) => f.includes('.orphaned-'))).toBe(false);
  });
});

describe('claude code adapter: session parsing', () => {
  it('extracts identity, title and metadata', async () => {
    const parsed = await claudeCodeAdapter.parseFile({ filePath: SESSION, root });
    expect(parsed?.sessionId).toBe('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');
    expect(parsed?.title).toBe('Fix failing build and tag release');
    expect(parsed?.cwd).toBe('/tmp/demo');
    expect(parsed?.gitBranch).toBe('main');
    expect(parsed?.models.sort()).toEqual(['demo-claude-1', 'demo-claude-2']);
  });

  it('maps prompts, tool calls, tool results and errors', async () => {
    const parsed = await claudeCodeAdapter.parseFile({ filePath: SESSION, root });
    const kinds = (k: string): number => parsed?.events.filter((e) => e.kind === k).length ?? 0;

    expect(kinds('user_prompt')).toBe(2);
    expect(kinds('tool_call')).toBe(3);
    // one tool_result was is_error:true, so it is classified as an error
    expect(kinds('tool_result')).toBe(2);
    expect(kinds('error')).toBe(1);
    expect(kinds('reasoning')).toBe(1);
  });

  it('labels tool results with the tool that produced them', async () => {
    const parsed = await claudeCodeAdapter.parseFile({ filePath: SESSION, root });
    const result = parsed?.events.find((e) => e.callId === 'toolu_2');
    expect(result?.toolName).toBe('Edit');
  });

  it('uses cost-state as the measured source, matching /cost', async () => {
    const parsed = await claudeCodeAdapter.parseFile({ filePath: SESSION, root });
    expect(parsed?.costUsd).toBeCloseTo(1.2345, 6);
    expect(parsed?.measured.apiMs).toBe(41_000);
    expect(parsed?.measured.toolMs).toBe(24_000);
    expect(parsed?.measured.totalMs).toBe(2_725_000);
  });

  it('sums token usage across assistant messages', async () => {
    const parsed = await claudeCodeAdapter.parseFile({ filePath: SESSION, root });
    expect(parsed?.tokens.input).toBe(10 + 5 + 2 + 3);
    expect(parsed?.tokens.output).toBe(120 + 80 + 60 + 40);
    expect(parsed?.tokens.cacheRead).toBe(4000 + 6000 + 6200 + 7000);
  });
});

describe('claude code adapter: subagents', () => {
  it('recognises the subagents/ path layout', () => {
    expect(detectSubagent('/a/projects/p/SESSION/subagents/agent-x.jsonl')).toEqual({
      parentSessionId: 'SESSION',
      agentLabel: 'agent-x',
    });
    expect(detectSubagent('C:\\a\\projects\\p\\SESSION\\subagents\\agent-x.jsonl')).toEqual({
      parentSessionId: 'SESSION',
      agentLabel: 'agent-x',
    });
    expect(detectSubagent('/a/projects/p/SESSION.jsonl')).toBeNull();
  });

  it('gives a subagent its own key instead of colliding with the parent', async () => {
    const parsed = await claudeCodeAdapter.parseFile({ filePath: SUBAGENT, root });
    expect(parsed?.parentSessionId).toBe('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');
    expect(parsed?.sessionId).toBe('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa#agent-demo');
    expect(parsed?.isSubagent).toBe(true);
    expect(parsed?.agentLabel).toBe('agent-demo');
  });
});

describe('claude code adapter: live markers', () => {
  it('reads sessions/<pid>.json and checks whether the pid is alive', async () => {
    const dir = await tempRoot();
    await mkdir(path.join(dir, 'sessions'), { recursive: true });
    const now = Date.now();
    await writeFile(
      path.join(dir, 'sessions', `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        sessionId: 'live-session',
        cwd: '/tmp/demo',
        status: 'busy',
        updatedAt: now,
      }),
      'utf8',
    );
    await writeFile(
      path.join(dir, 'sessions', '999999.json'),
      JSON.stringify({ pid: 999999, sessionId: 'dead-session', status: 'idle', updatedAt: now }),
      'utf8',
    );
    await writeFile(path.join(dir, 'sessions', 'garbage.json'), 'not json', 'utf8');

    const markers = await claudeCodeAdapter.collectLiveMarkers?.(dir);
    expect(markers).toHaveLength(2);

    const live = markers?.find((m) => m.sessionId === 'live-session');
    expect(live?.state).toBe('busy');
    expect(live?.pidAlive).toBe(true);

    const dead = markers?.find((m) => m.sessionId === 'dead-session');
    expect(dead?.pidAlive).toBe(false);
  });

  it('returns nothing when the marker directory is absent', async () => {
    const dir = await tempRoot();
    expect(await claudeCodeAdapter.collectLiveMarkers?.(dir)).toEqual([]);
  });
});

describe('claude code adapter: malformed input', () => {
  it('survives an empty file, a binary file and a half-written line', async () => {
    const dir = await tempRoot();
    const projects = path.join(dir, 'projects', '-tmp-x');
    await mkdir(projects, { recursive: true });

    const empty = path.join(projects, 'empty.jsonl');
    await writeFile(empty, '', 'utf8');
    expect(await claudeCodeAdapter.parseFile({ filePath: empty, root: fakeRoot('claude-code', dir) })).toBeNull();

    const junk = path.join(projects, 'junk.jsonl');
    await writeFile(junk, '\u0000\u0001\u0002not json at all\n[]\n"string"\n', 'utf8');
    expect(await claudeCodeAdapter.parseFile({ filePath: junk, root: fakeRoot('claude-code', dir) })).toBeNull();

    const partial = path.join(projects, 'partial.jsonl');
    await writeFile(
      partial,
      `${JSON.stringify({
        type: 'user',
        sessionId: 'p1',
        uuid: 'u1',
        timestamp: '2024-03-04T09:00:00.000Z',
        message: { role: 'user', content: 'hello' },
      })}\n{"type":"assist`,
      'utf8',
    );
    const parsed = await claudeCodeAdapter.parseFile({
      filePath: partial,
      root: fakeRoot('claude-code', dir),
    });
    expect(parsed?.events).toHaveLength(1);
    expect(parsed?.warnings.some((w) => w.includes('partial line'))).toBe(true);
  });

  it('does not throw when the file disappears mid-read', async () => {
    const dir = await tempRoot();
    const missing = path.join(dir, 'gone.jsonl');
    await expect(
      claudeCodeAdapter.parseFile({ filePath: missing, root: fakeRoot('claude-code', dir) }),
    ).resolves.toBeNull();
  });
});
