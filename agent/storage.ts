/**
 * Postgres connection for everything NextGig persists.
 *
 * The database is a knowledge store declared in astropods.yml
 * (`knowledge.db.provider: postgres`), deployed alongside the agent with its own
 * persistent volume. The platform generates a managed user and a random
 * password, then injects five env vars into the agent container:
 *
 *   POSTGRES_HOST  POSTGRES_PORT  POSTGRES_USER  POSTGRES_PASSWORD  POSTGRES_DB
 *
 * Always read all five (POSTGRES_URL is also injected but is not reliable across
 * client libraries). Nothing is hardcoded except localhost fallbacks for a
 * developer running their own Postgres outside `ast project start`.
 *
 * Why not the agent's filesystem: the spec has no volume option for the agent,
 * so ./data is wiped by any rebuild or redeploy — which would silently lose the
 * user's profile and application history.
 */

import { Client, Pool } from 'pg';

export interface PgSettings {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

/** Connection settings from the injected env vars. */
export function pgSettings(): PgSettings {
  return {
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number.parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
    database: process.env.POSTGRES_DB ?? 'postgres',
    user: process.env.POSTGRES_USER ?? 'postgres',
    password: process.env.POSTGRES_PASSWORD ?? 'postgres',
  };
}

/**
 * Connection string, for libraries that only take a URL (Mastra's PostgresStore).
 * Built from the same env vars rather than using POSTGRES_URL directly, and the
 * password is percent-encoded because the platform generates it randomly.
 */
export function pgConnectionString(): string {
  const { host, port, database, user, password } = pgSettings();
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

let pool: Pool | null = null;

/** Shared connection pool. Created on first use, reused thereafter. */
export function pgPool(): Pool {
  if (pool) return pool;
  const settings = pgSettings();
  pool = new Pool({
    ...settings,
    // Keep well under Postgres' default 100 connections: this pool, Mastra's
    // memory store, and the scheduler all share one small container.
    max: 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  // A pool error (server restart, network blip) must not take the process down;
  // the next query re-establishes a connection.
  pool.on('error', (err) => console.error('[db] idle client error:', err.message));
  console.log(`[db] postgres ${settings.host}:${settings.port}/${settings.database} as ${settings.user}`);
  return pool;
}

/** True when the platform injected Postgres credentials (i.e. the store is wired). */
export function hasPgCredentials(): boolean {
  return Boolean(process.env.POSTGRES_HOST && process.env.POSTGRES_PASSWORD);
}

/**
 * Make sure the target database exists, creating it if not.
 *
 * A Postgres container only runs `POSTGRES_DB` creation when it initializes an
 * empty data directory. A volume that was already initialized — by an earlier
 * project in local dev, or by a store that predates this agent — therefore has
 * the user and password but no `nextgig` database, and every connection fails
 * with `3D000 database "…" does not exist`. Creating it here turns that fatal,
 * confusing startup crash into a one-line log.
 *
 * Returns true when the database is reachable. Never throws.
 */
export async function ensureDatabase(): Promise<boolean> {
  const settings = pgSettings();
  try {
    await probe(settings.database);
    return true;
  } catch (err) {
    if (errorCode(err) !== INVALID_CATALOG_NAME) {
      console.error(`[db] cannot reach postgres at ${settings.host}:${settings.port}:`, message(err));
      return false;
    }
  }

  // The server is up but this database is missing — create it from the
  // maintenance database. Identifiers can't be parameterized, so the name is
  // quoted (it comes from platform config, not user input).
  try {
    const admin = new Client({ ...settings, database: 'postgres' });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${settings.database.replace(/"/g, '""')}"`);
      console.log(`[db] created missing database "${settings.database}"`);
    } finally {
      await admin.end();
    }
    await probe(settings.database);
    return true;
  } catch (err) {
    console.error(`[db] database "${settings.database}" is missing and could not be created:`, message(err));
    return false;
  }
}

/** Postgres error code for "database does not exist". */
const INVALID_CATALOG_NAME = '3D000';

async function probe(database: string): Promise<void> {
  const client = new Client({ ...pgSettings(), database, connectionTimeoutMillis: 10_000 });
  await client.connect();
  await client.end();
}

function errorCode(err: unknown): string | undefined {
  return (err as { code?: string })?.code;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
