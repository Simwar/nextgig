/**
 * Subscription store for nextgig.
 *
 * Persists each user's skill matrix, location preferences, notification
 * settings, and the postings they have applied to, in the Postgres knowledge
 * store deployed with the agent (see agent/storage.ts) so they survive restarts
 * and redeploys and are available to the in-process scheduler. Mastra memory
 * uses the same database, in its own tables.
 *
 * Epoch-millisecond timestamps are stored as BIGINT, which node-postgres returns
 * as a string to avoid precision loss — every read goes through Number().
 */

import type { Pool } from 'pg';
import { pgPool } from './storage';

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

let ready: Promise<Pool> | null = null;

/**
 * The pool, with the schema created. Safe to call repeatedly and concurrently:
 * the bootstrap promise is cached, so the CREATE TABLE statements run once per
 * process (and are idempotent anyway).
 */
export function getDb(): Promise<Pool> {
  if (!ready) {
    ready = createSchema().catch((err) => {
      // Don't cache a failure — a transient outage at boot would otherwise
      // poison every later query.
      ready = null;
      throw err;
    });
  }
  return ready;
}

async function createSchema(): Promise<Pool> {
  const pool = pgPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id          TEXT PRIMARY KEY,
      email       TEXT NOT NULL DEFAULT '',
      city        TEXT NOT NULL DEFAULT '',
      country     TEXT NOT NULL DEFAULT '',
      remote      TEXT NOT NULL DEFAULT 'any',
      matrix_json TEXT NOT NULL DEFAULT '{}',
      cadence     TEXT NOT NULL DEFAULT 'daily',
      active      BOOLEAN NOT NULL DEFAULT FALSE,
      last_run_at BIGINT,
      created_at  BIGINT NOT NULL,
      updated_at  BIGINT NOT NULL
    )
  `);
  // Jobs already emailed to a subscriber, for cross-run de-duplication.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sent_jobs (
      sub_id      TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      url         TEXT NOT NULL DEFAULT '',
      title       TEXT NOT NULL DEFAULT '',
      company     TEXT NOT NULL DEFAULT '',
      sent_at     BIGINT NOT NULL,
      PRIMARY KEY (sub_id, fingerprint)
    )
  `);
  // Postings the user says they applied to. Keyed by the same fingerprint as
  // sent_jobs so "did I apply to this?" and "was this emailed?" line up.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS applications (
      sub_id      TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      url         TEXT NOT NULL DEFAULT '',
      title       TEXT NOT NULL DEFAULT '',
      company     TEXT NOT NULL DEFAULT '',
      location    TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'applied',
      notes       TEXT NOT NULL DEFAULT '',
      applied_at  BIGINT NOT NULL,
      updated_at  BIGINT NOT NULL,
      PRIMARY KEY (sub_id, fingerprint)
    )
  `);
  // One row per digest run (history of every search), for audit/debugging.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS digest_runs (
      id          BIGSERIAL PRIMARY KEY,
      sub_id      TEXT NOT NULL,
      ran_at      BIGINT NOT NULL,
      found_count INTEGER NOT NULL,
      new_count   INTEGER NOT NULL,
      sent        BOOLEAN NOT NULL
    )
  `);
  // Operator settings (e.g. the Resend key set in the app's Settings panel).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  // Every read of these tables is "rows for one subscriber, newest first".
  await pool.query('CREATE INDEX IF NOT EXISTS sent_jobs_sub_sent_at ON sent_jobs (sub_id, sent_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS applications_sub_applied_at ON applications (sub_id, applied_at DESC)');
  return pool;
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
    active: row.active === true,
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
  const res = await db.query('SELECT * FROM subscriptions WHERE id = $1', [id]);
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

  await db.query(
    `
      INSERT INTO subscriptions
        (id, email, city, country, remote, matrix_json, cadence, active, last_run_at, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (id) DO UPDATE SET
        email = EXCLUDED.email,
        city = EXCLUDED.city,
        country = EXCLUDED.country,
        remote = EXCLUDED.remote,
        matrix_json = EXCLUDED.matrix_json,
        cadence = EXCLUDED.cadence,
        active = EXCLUDED.active,
        last_run_at = EXCLUDED.last_run_at,
        updated_at = EXCLUDED.updated_at
    `,
    [
      merged.id,
      merged.email,
      merged.city,
      merged.country,
      merged.remote,
      JSON.stringify(merged.matrix),
      merged.cadence,
      merged.active,
      merged.lastRunAt,
      merged.createdAt,
      merged.updatedAt,
    ],
  );

  return merged;
}

/** All active subscriptions that are due for a notification given the clock `now`. */
export async function getDueSubscriptions(now: number): Promise<Subscription[]> {
  const db = await getDb();
  const res = await db.query('SELECT * FROM subscriptions WHERE active = TRUE');
  return res.rows
    .map((r) => rowToSubscription(r as Record<string, unknown>))
    .filter((s) => s.email && isDue(s, now));
}

/** Mark a subscription as having just been notified. */
export async function markNotified(id: string, when: number): Promise<void> {
  const db = await getDb();
  await db.query('UPDATE subscriptions SET last_run_at = $1, updated_at = $2 WHERE id = $3', [
    when,
    when,
    id,
  ]);
}

/** Where an application stands. Free-form beyond these is not accepted. */
export type ApplicationStatus = 'applied' | 'interviewing' | 'offer' | 'rejected' | 'withdrawn';

/** A posting the user told us they applied to. */
export interface Application {
  /** Same identity scheme as sent_jobs, so a posting matches across features. */
  fingerprint: string;
  url: string;
  title: string;
  company: string;
  location: string;
  status: ApplicationStatus;
  notes: string;
  /** When the user first told us they applied. Never moved by later updates. */
  appliedAt: number;
  updatedAt: number;
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
  const res = await db.query(
    'SELECT fingerprint, url, title, company FROM sent_jobs WHERE sub_id = $1 AND sent_at >= $2 ORDER BY sent_at DESC LIMIT $3',
    [subId, sinceMs, limit],
  );
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
    const res = await db.query(
      `INSERT INTO sent_jobs (sub_id, fingerprint, url, title, company, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (sub_id, fingerprint) DO NOTHING`,
      [subId, j.fingerprint, j.url, j.title, j.company, when],
    );
    inserted += res.rowCount ?? 0;
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
  await db.query(
    'INSERT INTO digest_runs (sub_id, ran_at, found_count, new_count, sent) VALUES ($1, $2, $3, $4, $5)',
    [subId, ranAt, foundCount, newCount, sent],
  );
}

/** Fields a caller can set when recording an application. */
export interface ApplicationInput {
  url?: string;
  title?: string;
  company?: string;
  location?: string;
  status?: ApplicationStatus;
  notes?: string;
}

/**
 * Record — or update — an application.
 *
 * Re-recording the same posting (same fingerprint) is an update, not a
 * duplicate: `appliedAt` is preserved and only the fields provided are changed,
 * so "I applied to this" followed later by "I got an interview" builds up one
 * row. `created` tells the caller which of the two happened.
 */
export async function recordApplication(
  subId: string,
  input: ApplicationInput,
  when: number,
): Promise<{ application: Application; created: boolean }> {
  const db = await getDb();
  const fingerprint = jobFingerprint(input);
  const existing = await getApplication(subId, fingerprint);

  const merged: Application = {
    fingerprint,
    // Keep the URL first recorded: an equal fingerprint means the same posting,
    // and the original is the one that was actually shown to the user. A later
    // mention often carries a scruffier variant (tracking params, odd casing).
    url: existing?.url || input.url || '',
    title: input.title ?? existing?.title ?? '',
    company: input.company ?? existing?.company ?? '',
    location: input.location ?? existing?.location ?? '',
    status: input.status ?? existing?.status ?? 'applied',
    notes: input.notes ?? existing?.notes ?? '',
    appliedAt: existing?.appliedAt ?? when,
    updatedAt: when,
  };

  await db.query(
    `
      INSERT INTO applications
        (sub_id, fingerprint, url, title, company, location, status, notes, applied_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (sub_id, fingerprint) DO UPDATE SET
        url = EXCLUDED.url,
        title = EXCLUDED.title,
        company = EXCLUDED.company,
        location = EXCLUDED.location,
        status = EXCLUDED.status,
        notes = EXCLUDED.notes,
        updated_at = EXCLUDED.updated_at
    `,
    [
      subId,
      merged.fingerprint,
      merged.url,
      merged.title,
      merged.company,
      merged.location,
      merged.status,
      merged.notes,
      merged.appliedAt,
      merged.updatedAt,
    ],
  );

  return { application: merged, created: existing === null };
}

export async function getApplication(
  subId: string,
  fingerprint: string,
): Promise<Application | null> {
  const db = await getDb();
  const res = await db.query('SELECT * FROM applications WHERE sub_id = $1 AND fingerprint = $2', [
    subId,
    fingerprint,
  ]);
  const row = res.rows[0];
  return row ? rowToApplication(row as Record<string, unknown>) : null;
}

/** Applications for a subscriber, most recently applied first. */
export async function listApplications(
  subId: string,
  limit = 100,
  status?: ApplicationStatus,
): Promise<Application[]> {
  const db = await getDb();
  const res = status
    ? await db.query(
        'SELECT * FROM applications WHERE sub_id = $1 AND status = $2 ORDER BY applied_at DESC LIMIT $3',
        [subId, status, limit],
      )
    : await db.query('SELECT * FROM applications WHERE sub_id = $1 ORDER BY applied_at DESC LIMIT $2', [
        subId,
        limit,
      ]);
  return res.rows.map((r) => rowToApplication(r as Record<string, unknown>));
}

function rowToApplication(row: Record<string, unknown>): Application {
  return {
    fingerprint: String(row.fingerprint),
    url: String(row.url ?? ''),
    title: String(row.title ?? ''),
    company: String(row.company ?? ''),
    location: String(row.location ?? ''),
    status: String(row.status || 'applied') as ApplicationStatus,
    notes: String(row.notes ?? ''),
    appliedAt: Number(row.applied_at),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * Stable identity for a posting: its normalized URL when there is one, else
 * title|company. Shared by sent_jobs de-duplication (agent/scheduler.ts) and
 * applications, so the same posting fingerprints identically in both.
 */
export function jobFingerprint(job: { url?: string; title?: string; company?: string }): string {
  const url = normalizeUrl(job.url ?? '');
  if (url) return 'u:' + url;
  return 't:' + (job.title ?? '').trim().toLowerCase() + '|' + (job.company ?? '').trim().toLowerCase();
}

/** Lowercase, strip scheme, query/fragment, and trailing slashes. */
export function normalizeUrl(url: string): string {
  return (url || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[#?].*$/, '')
    .replace(/\/+$/, '');
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A subscription is due when its cadence interval has elapsed since lastRunAt. */
export function isDue(sub: Subscription, now: number): boolean {
  if (!sub.active) return false;
  if (sub.lastRunAt == null) return true; // never sent → send on next tick
  const interval = sub.cadence === 'weekly' ? 7 * DAY_MS : DAY_MS;
  return now - sub.lastRunAt >= interval;
}
