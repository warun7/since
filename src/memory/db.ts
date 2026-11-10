// SQLite connection and schema migrations for long-term memory.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

// Each entry upgrades the schema by one version. Never edit a shipped entry; append a new one.
// The index + 1 is stored in PRAGMA user_version, so a fresh file runs all of them in order.
const MIGRATIONS: Array<(db: Database.Database) => void> = [
  (db) => {
    db.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sources_json TEXT,
        trace_json TEXT,
        verification_json TEXT
      );
      CREATE INDEX messages_conversation_created ON messages(conversation_id, created_at);

      CREATE TABLE sources (
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        n INTEGER NOT NULL,
        url TEXT NOT NULL,
        title TEXT,
        site TEXT,
        published TEXT,
        authority INTEGER,
        passages_json TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (conversation_id, n)
      );

      -- One row per answered question. The memory unit: recall reads these, not raw messages.
      CREATE TABLE turns (
        message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        asked_at TEXT NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        summary TEXT,
        topics_json TEXT NOT NULL DEFAULT '[]',
        entities_json TEXT NOT NULL DEFAULT '[]',
        claims_json TEXT NOT NULL DEFAULT '[]',
        sources_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX turns_asked_at ON turns(asked_at);

      -- Maintained by store.ts, not triggers: the body is assembled from several columns
      -- and JSON arrays, which triggers would have to re-parse on every write.
      CREATE VIRTUAL TABLE turns_fts USING fts5(message_id UNINDEXED, body, tokenize='porter unicode61');
    `);
  },
];

/**
 * Open (creating if needed) the memory database and bring its schema up to date.
 * ':memory:' is used by tests and skips directory creation.
 */
export function openDb(dbPath: string = config.dbPath): Database.Database {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  // WAL lets the background memory writer commit while the chat path reads.
  db.pragma('journal_mode = WAL');
  // SQLite leaves foreign keys off by default; the ON DELETE CASCADE rules depend on them.
  db.pragma('foreign_keys = ON');
  // Wait for a writer lock instead of failing with SQLITE_BUSY.
  db.pragma('busy_timeout = 3000');
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    // Each step and its version bump commit together, so a crash never leaves them out of step.
    db.transaction(() => {
      MIGRATIONS[v](db);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
