/**
 * Small key/value settings store, backed by the same file-backed LibSQL db as
 * subscriptions. Used for runtime-configurable operator settings (e.g. the
 * Resend API key entered from the app's Settings panel) that should persist
 * across restarts without a redeploy.
 *
 * Secrets set via environment variables take precedence over stored values
 * (see agent/email.ts) — this store is the convenient in-app fallback.
 */

import { getDb } from './db';

let ensured = false;

async function ensureTable() {
  if (ensured) return;
  const db = await getDb();
  await db.execute(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  ensured = true;
}

export async function getSetting(key: string): Promise<string | null> {
  await ensureTable();
  const db = await getDb();
  const res = await db.execute({ sql: 'SELECT value FROM settings WHERE key = ?', args: [key] });
  const row = res.rows[0];
  return row ? String(row.value) : null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await ensureTable();
  const db = await getDb();
  await db.execute({
    sql: `INSERT INTO settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [key, value],
  });
}

export async function deleteSetting(key: string): Promise<void> {
  await ensureTable();
  const db = await getDb();
  await db.execute({ sql: 'DELETE FROM settings WHERE key = ?', args: [key] });
}
