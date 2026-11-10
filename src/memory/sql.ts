// The SQLite operations memory needs. Two implementations, both synchronous:
// better-sqlite3 on Node (memory/db.ts) and a Durable Object's built-in SQLite on
// Cloudflare (cloud/worker.ts). The store and the schema only ever see this interface.

export type SqlValue = string | number | null;

export interface Sql {
  /** Every row a query returns. */
  all<T>(query: string, ...params: SqlValue[]): T[];
  /** The first row a query returns, if any. */
  get<T>(query: string, ...params: SqlValue[]): T | undefined;
  /** A statement that returns no rows. */
  run(query: string, ...params: SqlValue[]): void;
  /** Several statements with no parameters, for schema changes. */
  exec(script: string): void;
  /** Runs fn so that all of its writes commit together, or none do. */
  transaction<T>(fn: () => T): T;
  /** The schema version that migrations have reached. */
  schemaVersion(): number;
  setSchemaVersion(version: number): void;
}
