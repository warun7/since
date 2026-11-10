// The memory schema and its migrations, shared by every SQLite backend.
import type { Sql } from './sql.js';

// Each entry upgrades the schema by one version. Never edit a shipped entry; append a new one.
// Version n means the first n entries have run, so a new database runs all of them in order.
const MIGRATIONS: Array<(sql: Sql) => void> = [
  (sql) =>
    sql.exec(`
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
    `),
];

export function migrate(sql: Sql): void {
  for (let v = sql.schemaVersion(); v < MIGRATIONS.length; v++) {
    // Each step and its version bump commit together, so a crash never leaves them out of step.
    sql.transaction(() => {
      MIGRATIONS[v](sql);
      sql.setSchemaVersion(v + 1);
    });
  }
}
