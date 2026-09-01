/**
 * Database bootstrap: connection, pragmas, schema application, transactions.
 *
 * The schema itself lives in ./schema.sql and is the single source of truth for
 * table and column names. It is written with IF NOT EXISTS throughout, so
 * applying it to an already-populated database is a no-op.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import SQLite from 'better-sqlite3';
import type { Database } from 'better-sqlite3';

/** Resolved relative to this module so it works from src/ and from any build output next to schema.sql. */
const SCHEMA_PATH = fileURLToPath(new URL('./schema.sql', import.meta.url));

let schemaCache: string | null = null;

/** The raw schema DDL. Cached -- it is read once per process. */
export function readSchema(): string {
  if (schemaCache === null) schemaCache = readFileSync(SCHEMA_PATH, 'utf8');
  return schemaCache;
}

/**
 * Apply pragmas + schema to an already-open connection. Idempotent.
 * Exported so tests can seed `new Database(':memory:')` with the exact
 * production schema instead of a hand-maintained copy.
 *
 * PRAGMAs are set here (not only via schema.sql) because foreign_keys is a
 * per-connection setting and must be re-asserted on every connection, while
 * journal_mode is persistent but harmless to repeat. On an in-memory database
 * WAL is silently refused and the journal stays "memory"; that is fine.
 */
export function applySchema(db: Database): void {
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.exec(readSchema());
  // schema.sql's own PRAGMA lines can be no-ops depending on driver ordering,
  // so re-assert the connection-scoped one afterwards.
  db.pragma('foreign_keys = ON');
  migrate(db);
}

/**
 * Additive migrations for databases created by an earlier version.
 *
 * schema.sql uses CREATE TABLE IF NOT EXISTS, which does nothing to a table
 * that already exists -- so a new column has to be added explicitly here.
 * Every step must be idempotent and safe to run on a fresh database too.
 */
function migrate(db: Database): void {
  addColumnIfMissing(db, 'steam_accounts', 'added_by', 'TEXT');
  addColumnIfMissing(db, 'games', 'source', "TEXT NOT NULL DEFAULT 'steam'");
  addColumnIfMissing(db, 'user_games', 'playtime_tracked', 'INTEGER NOT NULL DEFAULT 1');
  // The partial unique index depends on games.source, so it cannot live in
  // schema.sql for databases created before that column existed.
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_games_manual_name
       ON games(name_folded) WHERE source = 'manual'`,
  );
}

function addColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  type: string,
): void {
  const cols = db.pragma(`table_info(${table})`) as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

/** Open (creating if needed) the database at `path` and bring it fully up to schema. */
export function openDb(path: string): Database {
  // SQLite creates the FILE but not its directory, so a fresh checkout with the
  // default ./data/bot.sqlite would otherwise fail on the very first run.
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new SQLite(path);
  applySchema(db);
  return db;
}

/**
 * Run `fn` inside a single transaction, rolling back if it throws.
 * better-sqlite3 is synchronous, so `fn` must be synchronous too; an async
 * function would commit before its work finished.
 */
export function inTransaction<T>(db: Database, fn: (db: Database) => T): T {
  const wrapped = db.transaction(() => fn(db));
  return wrapped();
}

export type { Database };
