/**
 * Small key/value settings store, in the same Postgres database as
 * subscriptions. Used for runtime-configurable operator settings (e.g. the
 * Resend API key entered from the app's Settings panel) that should persist
 * across restarts without a redeploy.
 *
 * Secrets set via environment variables take precedence over stored values
 * (see agent/email.ts) — this store is the convenient in-app fallback.
 *
 * The table is created with the rest of the schema in agent/db.ts.
 */

import { getDb } from './db';

export async function getSetting(key: string): Promise<string | null> {
  const db = await getDb();
  const res = await db.query('SELECT value FROM settings WHERE key = $1', [key]);
  const row = res.rows[0];
  return row ? String(row.value) : null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
}

export async function deleteSetting(key: string): Promise<void> {
  const db = await getDb();
  await db.query('DELETE FROM settings WHERE key = $1', [key]);
}
