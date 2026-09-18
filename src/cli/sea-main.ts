/**
 * Entry point for the standalone single-executable build.
 *
 * The normal CLI only runs `main()` when it detects that it is the process
 * entry point, which it does by comparing `import.meta.url` against `argv[1]`.
 * Neither is meaningful inside a single executable, so the packaged build uses
 * this explicit entry instead of trying to make that detection clever.
 */
import { main } from './main.js';

void main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
