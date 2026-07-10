/**
 * Subscription store for nextgig.
 *
 * Persists each user's skill matrix, location preferences, and notification
 * settings to a file-backed LibSQL database so they survive restarts and are
 * available to the in-process scheduler. Shares the same db file as Mastra
 * memory (different table).
 */

import { createClient, type Client } from '@libsql/client';
import { dbUrl } from './storage';

export type RemotePreference = 'remote' | 'hybrid' | 'onsite' | 'any';
export type Cadence = 'daily' | 'weekly';

/** A single skill with a self-assessed proficiency level. */
export interface Skill {
  name: string;
  /** e.g. "expert" | "advanced" | "intermediate" | "beginner" */
  level: string;
  /** Approximate years of experience, if inferable. */
  years?: number;
}

/** Structured skill matrix extracted from a pasted LinkedIn profile / resume. */
export interface SkillMatrix {
  /** Headline / current role, e.g. "Senior Backend Engineer". */
  headline?: string;
  /** Target job titles to search for. */
  targetTitles: string[];
  skills: Skill[];
  /** Free-form notes (industries, seniority, domains) to refine searches. */
  notes?: string;
}

export interface Subscription {
  /** Stable per-user id (conversationId or userId from the messaging layer). */
  id: string;
  email: string;
  city: string;
  country: string;
  remote: RemotePreference;
  matrix: SkillMatrix;
  cadence: Cadence;
  active: boolean;
  lastRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

let client: Client | null = null;

/** Lazily create the LibSQL client + table. Safe to call repeatedly. */
export async function getDb(): Promise<Client> {
  if (client) return client;
  client = createClient({ url: dbUrl() });
  await client.execute(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id          TEXT PRIMARY KEY,
      email       TEXT NOT NULL,
      city        TEXT NOT NULL DEFAULT '',
      country     TEXT NOT NULL DEFAULT '',
      remote      TEXT NOT NULL DEFAULT 'any',
      matrix_json TEXT NOT NULL DEFAULT '{}',
      cadence     TEXT NOT NULL DEFAULT 'daily',
      active      INTEGER NOT NULL DEFAULT 1,
      last_run_at INTEGER,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    )
  `);
  // Jobs already emailed to a subscriber, for cross-run de-duplication.
  await client.execute(`
    CREATE TABLE IF NOT EXISTS sent_jobs (
      sub_id      TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      url         TEXT NOT NULL DEFAULT '',
      title       TEXT NOT NULL DEFAULT '',
      company     TEXT NOT NULL DEFAULT '',
      sent_at     INTEGER NOT NULL,
      PRIMARY KEY (sub_id, fingerprint)
    )
  `);
  // One row per digest run (history of every search), for audit/debugging.
  await client.execute(`
    CREATE TABLE IF NOT EXISTS digest_runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      sub_id      TEXT NOT NULL,
      ran_at      INTEGER NOT NULL,
      found_count INTEGER NOT NULL,
      new_count   INTEGER NOT NULL,
      sent        INTEGER NOT NULL
    )
  `);
  return client;
}

function rowToSubscription(row: Record<string, unknown>): Subscription {
  return {
    id: String(row.id),
    email: String(row.email),
    city: String(row.city ?? ''),
    country: String(row.country ?? ''),
    remote: (String(row.remote || 'any') as RemotePreference),
    matrix: safeParseMatrix(String(row.matrix_json ?? '{}')),
    cadence: (String(row.cadence || 'daily') as Cadence),
    active: Number(row.active) === 1,
    lastRunAt: row.last_run_at == null ? null : Number(row.last_run_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function safeParseMatrix(json: string): SkillMatrix {
  try {
    const parsed = JSON.parse(json);
    return {
      headline: parsed.headline,
      targetTitles: Array.isArray(parsed.targetTitles) ? parsed.targetTitles : [],
      skills: Array.isArray(parsed.skills) ? parsed.skills : [],
      notes: parsed.notes,
    };
  } catch {
    return { targetTitles: [], skills: [] };
  }
}

export async function getSubscription(id: string): Promise<Subscription | null> {
  const db = await getDb();
  const res = await db.execute({ sql: 'SELECT * FROM subscriptions WHERE id = ?', args: [id] });
  const row = res.rows[0];
  return row ? rowToSubscription(row as Record<string, unknown>) : null;
}

/**
 * Insert or update a subscription. Only the provided fields are changed;
 * omitted fields keep their existing values (or sensible defaults on insert).
 */
export async function upsertSubscription(
  id: string,
  patch: Partial<Omit<Subscription, 'id' | 'createdAt' | 'updatedAt'>>,
): Promise<Subscription> {
  const db = await getDb();
  const now = Date.now();
  const existing = await getSubscription(id);

  const merged: Subscription = {
    id,
    email: patch.email ?? existing?.email ?? '',
    city: patch.city ?? existing?.city ?? '',
    country: patch.country ?? existing?.country ?? '',
    remote: patch.remote ?? existing?.remote ?? 'any',
    matrix: patch.matrix ?? existing?.matrix ?? { targetTitles: [], skills: [] },
    cadence: patch.cadence ?? existing?.cadence ?? 'daily',
    active: patch.active ?? existing?.active ?? false,
    lastRunAt: patch.lastRunAt ?? existing?.lastRunAt ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  await db.execute({
    sql: `
      INSERT INTO subscriptions
        (id, email, city, country, remote, matrix_json, cadence, active, last_run_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        email = excluded.email,
        city = excluded.city,
        country = excluded.country,
        remote = excluded.remote,
        matrix_json = excluded.matrix_json,
        cadence = excluded.cadence,
        active = excluded.active,
        last_run_at = excluded.last_run_at,
        updated_at = excluded.updated_at
    `,
    args: [
      merged.id,
      merged.email,
      merged.city,
      merged.country,
      merged.remote,
      JSON.stringify(merged.matrix),
      merged.cadence,
      merged.active ? 1 : 0,
      merged.lastRunAt,
      merged.createdAt,
      merged.updatedAt,
    ],
  });

  return merged;
}

/** All active subscriptions that are due for a notification given the clock `now`. */
export async function getDueSubscriptions(now: number): Promise<Subscription[]> {
  const db = await getDb();
  const res = await db.execute({ sql: 'SELECT * FROM subscriptions WHERE active = 1', args: [] });
  return res.rows
    .map((r) => rowToSubscription(r as Record<string, unknown>))
    .filter((s) => s.email && isDue(s, now));
}

/** Mark a subscription as having just been notified. */
export async function markNotified(id: string, when: number): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: 'UPDATE subscriptions SET last_run_at = ?, updated_at = ? WHERE id = ?',
    args: [when, when, id],
  });
}

export interface SentJobRecord {
  fingerprint: string;
  url: string;
  title: string;
  company: string;
}

/** Jobs emailed to this subscriber since `sinceMs`, most recent first. */
export async function getRecentSentJobs(
  subId: string,
  sinceMs: number,
  limit: number,
): Promise<SentJobRecord[]> {
  const db = await getDb();
  const res = await db.execute({
    sql: 'SELECT fingerprint, url, title, company FROM sent_jobs WHERE sub_id = ? AND sent_at >= ? ORDER BY sent_at DESC LIMIT ?',
    args: [subId, sinceMs, limit],
  });
  return res.rows.map((r) => ({
    fingerprint: String(r.fingerprint),
    url: String(r.url ?? ''),
    title: String(r.title ?? ''),
    company: String(r.company ?? ''),
  }));
}

/** Record newly-sent jobs. Existing (sub_id, fingerprint) pairs are ignored. */
export async function recordSentJobs(
  subId: string,
  jobs: SentJobRecord[],
  when: number,
): Promise<number> {
  if (!jobs.length) return 0;
  const db = await getDb();
  let inserted = 0;
  for (const j of jobs) {
    const res = await db.execute({
      sql: 'INSERT OR IGNORE INTO sent_jobs (sub_id, fingerprint, url, title, company, sent_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: [subId, j.fingerprint, j.url, j.title, j.company, when],
    });
    inserted += Number(res.rowsAffected ?? 0);
  }
  return inserted;
}

/** Append a history row for one digest run. */
export async function logDigestRun(
  subId: string,
  ranAt: number,
  foundCount: number,
  newCount: number,
  sent: boolean,
): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: 'INSERT INTO digest_runs (sub_id, ran_at, found_count, new_count, sent) VALUES (?, ?, ?, ?, ?)',
    args: [subId, ranAt, foundCount, newCount, sent ? 1 : 0],
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A subscription is due when its cadence interval has elapsed since lastRunAt. */
export function isDue(sub: Subscription, now: number): boolean {
  if (!sub.active) return false;
  if (sub.lastRunAt == null) return true; // never sent → send on next tick
  const interval = sub.cadence === 'weekly' ? 7 * DAY_MS : DAY_MS;
  return now - sub.lastRunAt >= interval;
}
