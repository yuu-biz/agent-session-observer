import type { ToolCategory } from './types.js';

/**
 * Coarse tool classification, shared by both adapters so the dashboard can say
 * "shell / edit / search" without knowing which CLI produced the event.
 *
 * Unknown names fall back to `other` rather than being dropped: a provider
 * shipping a new tool should still show up in the timeline.
 */

const EXACT: Record<string, ToolCategory> = {
  // Claude Code
  bash: 'shell',
  powershell: 'shell',
  read: 'file_read',
  notebookread: 'file_read',
  write: 'file_edit',
  edit: 'file_edit',
  multiedit: 'file_edit',
  notebookedit: 'file_edit',
  glob: 'search',
  grep: 'search',
  websearch: 'web',
  webfetch: 'web',
  agent: 'agent',
  task: 'agent',
  // Codex
  shell: 'shell',
  shell_command: 'shell',
  local_shell: 'shell',
  exec_command: 'shell',
  apply_patch: 'file_edit',
  update_plan: 'other',
  view_image: 'file_read',
  web_search: 'web',
};

/** Tool call names that are worth surfacing as a "notable event". */
const NOTABLE_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /\bgit\s+(commit|push|tag|merge|rebase)\b/i, label: 'git' },
  { re: /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|vitest|jest)\b/i, label: 'test' },
  { re: /\b(pytest|go\s+test|cargo\s+test|dotnet\s+test|mvn\s+test)\b/i, label: 'test' },
  { re: /\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b/i, label: 'build' },
  { re: /\b(cargo\s+build|go\s+build|tsc|make|gradle|msbuild)\b/i, label: 'build' },
  { re: /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(lint|typecheck)\b/i, label: 'lint' },
  { re: /\bgh\s+(release|pr|repo)\b/i, label: 'release' },
  { re: /\b(docker|kubectl|terraform)\b/i, label: 'infra' },
];

export function categorizeTool(name: string | undefined): ToolCategory {
  if (!name) return 'other';
  const lower = name.toLowerCase();
  const exact = EXACT[lower];
  if (exact) return exact;
  if (lower.startsWith('mcp__') || lower.includes('mcp_')) return 'mcp';
  if (lower.includes('search') || lower.includes('grep') || lower.includes('glob')) return 'search';
  if (lower.includes('web') || lower.includes('fetch') || lower.includes('browser')) return 'web';
  if (lower.includes('edit') || lower.includes('patch') || lower.includes('write')) return 'file_edit';
  if (lower.includes('read') || lower.includes('cat')) return 'file_read';
  if (lower.includes('shell') || lower.includes('exec') || lower.includes('command')) return 'shell';
  if (lower.includes('agent') || lower.includes('task')) return 'agent';
  return 'other';
}

/**
 * Classifies a shell command into a notable-event label (`test`, `build`,
 * `git`, ...), or `null` when it is routine. Only the command string is
 * inspected; output is never scanned.
 */
export function notableLabel(commandOrName: string | undefined): string | null {
  if (!commandOrName) return null;
  for (const { re, label } of NOTABLE_PATTERNS) {
    if (re.test(commandOrName)) return label;
  }
  return null;
}

/** Collapses whitespace and caps length for one-line list rendering. */
export function oneLine(text: string | undefined, max = 160): string {
  if (!text) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
