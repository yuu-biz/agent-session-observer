/**
 * Liveness check for a local pid.
 *
 * `process.kill(pid, 0)` sends no signal; it only asks the OS whether the pid
 * exists and is reachable. `EPERM` means the process exists but belongs to
 * another user, which still counts as alive.
 *
 * Caveat, and the reason this returns a plain boolean rather than a promise:
 * pids are recycled, so a very old marker file could name a pid that now
 * belongs to something unrelated. Callers pair this with the marker's own
 * heartbeat timestamp before trusting it.
 */
export function isPidAlive(pid: number): boolean | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    if (code === 'ESRCH') return false;
    return undefined;
  }
}
