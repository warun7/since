// Memory on Node: a SQLite file through better-sqlite3. (On Cloudflare, cloud/worker.ts
// gives the same store a Durable Object's SQLite instead.)
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { migrate } from './schema.js';
import type { Sql } from './sql.js';
import { MemoryStore } from './store.js';

/**
 * Open (creating if needed) the memory database and bring its schema up to date.
 * ':memory:' is used by tests and skips directory creation.
 */
export function openDb(dbPath: string = config.dbPath): Sql {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  // WAL lets the background memory writer commit while the chat path reads.
  db.pragma('journal_mode = WAL');
  // SQLite leaves foreign keys off by default; the ON DELETE CASCADE rules depend on them.
  db.pragma('foreign_keys = ON');
  // Wait for a writer lock instead of failing with SQLITE_BUSY.
  db.pragma('busy_timeout = 3000');

  const sql: Sql = {
    all: (query, ...params) => db.prepare(query).all(...params) as never,
    get: (query, ...params) => db.prepare(query).get(...params) as never,
    run: (query, ...params) => void db.prepare(query).run(...params),
    exec: (script) => void db.exec(script),
    transaction: (fn) => db.transaction(fn)(),
    schemaVersion: () => db.pragma('user_version', { simple: true }) as number,
    setSchemaVersion: (v) => void db.pragma(`user_version = ${Math.trunc(v)}`),
  };
  migrate(sql);
  return sql;
}

export function openStore(dbPath?: string): MemoryStore {
  return new MemoryStore(openDb(dbPath));
}
