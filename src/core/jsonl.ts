import { createReadStream } from 'node:fs';

/**
 * Tolerant streaming JSONL reader.
 *
 * Session logs are append-only files that the agent may be writing *right now*,
 * so the last line is routinely a partial JSON fragment. Reading must therefore
 * never throw, and must report exactly how many bytes were safely consumed so
 * an incremental re-read can resume from a line boundary.
 *
 * Encoding is pinned to UTF-8 explicitly: both providers write UTF-8, and
 * relying on the platform default silently corrupts non-ASCII prompts on
 * Windows (cp932 / cp1252 consoles).
 */

export interface JsonlLine {
  /** Parsed object, or `null` when the line was not valid JSON. */
  value: unknown;
  /** 1-based line number within the whole file. */
  lineNo: number;
  /** Raw text, only populated for malformed lines (for the warning message). */
  raw?: string;
}

export interface JsonlReadResult {
  /** Byte offset up to and including the last complete line. */
  bytesConsumed: number;
  malformedLines: number;
  totalLines: number;
  /** True when the file ended with an incomplete line. */
  trailingPartial: boolean;
}

export interface ReadJsonlOptions {
  /** Resume from this byte offset. Must be a line boundary. */
  fromOffset?: number;
  /** 1-based line number to report for the first line read. */
  startLineNo?: number;
  /** Lines longer than this are skipped as malformed to bound memory. */
  maxLineBytes?: number;
}

export const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;

/**
 * Streams a JSONL file, invoking `onLine` for each complete line.
 *
 * Returning `false` from `onLine` stops reading early; `bytesConsumed` then
 * reflects only what was actually processed.
 */
export async function readJsonl(
  filePath: string,
  onLine: (line: JsonlLine) => boolean | void,
  options: ReadJsonlOptions = {},
): Promise<JsonlReadResult> {
  const fromOffset = Math.max(0, options.fromOffset ?? 0);
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  let lineNo = options.startLineNo ?? 1;

  let consumed = fromOffset;
  let malformedLines = 0;
  let totalLines = 0;
  let trailingPartial = false;

  const stream = createReadStream(filePath, { start: fromOffset });
  let pending: Buffer = Buffer.alloc(0);
  let stopped = false;

  const handleChunk = (chunk: Buffer): void => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let searchFrom = 0;

    for (;;) {
      const nl = pending.indexOf(0x0a, searchFrom);
      if (nl === -1) break;

      const rawLine = pending.subarray(0, nl);
      const consumedBytes = nl + 1;
      pending = pending.subarray(consumedBytes);
      consumed += consumedBytes;
      searchFrom = 0;

      // Strip a trailing CR so CRLF logs parse identically.
      const body =
        rawLine.length > 0 && rawLine[rawLine.length - 1] === 0x0d
          ? rawLine.subarray(0, rawLine.length - 1)
          : rawLine;

      if (body.length === 0) {
        lineNo += 1;
        continue;
      }
      totalLines += 1;

      if (body.length > maxLineBytes) {
        malformedLines += 1;
        lineNo += 1;
        continue;
      }

      const text = body.toString('utf8');
      let value: unknown = null;
      let ok = true;
      try {
        value = JSON.parse(text);
      } catch {
        ok = false;
        malformedLines += 1;
      }

      const result = onLine(
        ok ? { value, lineNo } : { value: null, lineNo, raw: text.slice(0, 200) },
      );
      lineNo += 1;
      if (result === false) {
        stopped = true;
        break;
      }
    }
  };

  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk) => {
      if (stopped) return;
      handleChunk(chunk as Buffer);
      if (stopped) stream.destroy();
    });
    stream.on('error', (err: NodeJS.ErrnoException) => {
      // A file deleted or rotated mid-read is normal, not an error worth
      // failing the whole scan for.
      if (err.code === 'ENOENT' || err.code === 'EBUSY' || err.code === 'EPERM') resolve();
      else reject(err);
    });
    stream.on('close', () => resolve());
    stream.on('end', () => resolve());
  });

  if (!stopped && pending.length > 0) trailingPartial = true;

  return { bytesConsumed: consumed, malformedLines, totalLines, trailingPartial };
}

/** Safe property access for records whose shape is not guaranteed. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
