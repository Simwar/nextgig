/**
 * Resolves the file-backed LibSQL database location.
 *
 * In production the container filesystem is read-only except for the
 * pre-created ./data dir (see Dockerfile). Override with DATA_DIR if needed.
 * Falls back to an in-memory db only when explicitly requested via
 * JOB_HUNTER_IN_MEMORY=1 (handy for throwaway tests).
 */
import { mkdirSync } from 'node:fs';

export function dbUrl(): string {
  if (process.env.JOB_HUNTER_IN_MEMORY === '1') return ':memory:';
  const dir = (process.env.DATA_DIR || './data').replace(/\/+$/, '');
  // SQLite creates the file but not its parent directory; ensure it exists.
  // Idempotent, and a no-op on the pre-created prod dir.
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Read-only FS or already-exists race — the dir is expected to exist anyway.
  }
  return `file:${dir}/job-hunter.db`;
}
