/**
 * Read-only database shell. No sqlite3 CLI needed -- better-sqlite3 is already
 * a dependency.
 *
 *   node scripts/db.mjs                       overview: tables and row counts
 *   node scripts/db.mjs "select * from users" run one statement
 *   DB_PATH=./data/dev.sqlite node scripts/db.mjs ...
 *
 * Opened readonly on purpose: the bot is a live writer, and WAL lets readers in
 * without blocking it, but nothing here should ever be able to change a row.
 */
import Database from 'better-sqlite3';

const path = process.env.DB_PATH ?? './data/bot.sqlite';
const sql = process.argv.slice(2).join(' ').trim();
const db = new Database(path, { readonly: true, fileMustExist: true });

if (sql === '') {
  const objs = db
    .prepare(`SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name`)
    .all();
  console.log(`${path}\n`);
  for (const o of objs) {
    const n = db.prepare(`SELECT count(*) AS c FROM "${o.name}"`).get().c;
    console.log(`  ${o.type.padEnd(5)} ${o.name.padEnd(18)} ${String(n).padStart(7)} rows`);
  }
  console.log('\nTry: node scripts/db.mjs "select * from steam_accounts"');
} else {
  const rows = db.prepare(sql).all();
  if (rows.length === 0) console.log('(no rows)');
  else console.table(rows);
}
db.close();
