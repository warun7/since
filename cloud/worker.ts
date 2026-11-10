// The hosted demo on Cloudflare. A Worker in front gives each visitor an id (a cookie) and
// forwards their API calls to that visitor's own Durable Object. The Durable Object keeps
// the visitor's memory in its built-in SQLite and serves the same API and MemoryStore as
// `npm run dev`, so visitors never see each other's history. The UI is static assets.
import { DurableObject } from 'cloudflare:workers';
import { createApi } from '../src/app.js';
import { migrate } from '../src/memory/schema.js';
import type { Sql } from '../src/memory/sql.js';
import { MemoryStore } from '../src/memory/store.js';

interface Env {
  DEEPSEEK_API_KEY: string;
}

/** Per visitor, in any 24 hours. Visitors can always run their own copy for more. */
const QUESTIONS_PER_VISITOR = 40;
/** Across all visitors, per UTC day: a ceiling on what the demo can spend. */
const QUESTIONS_PER_DAY = 1500;
/** Example history runs three real turns, so it counts as three questions. */
const EXAMPLE_HISTORY_COST = 3;

const COOKIE = 'since_visitor';
const VISITOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A Durable Object's SQLite, behind the same interface as better-sqlite3 on Node. */
function durableSql(storage: DurableObjectStorage): Sql {
  const rows = (query: string, params: unknown[]) => storage.sql.exec(query, ...params).toArray();
  storage.sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)');
  return {
    all: (query, ...params) => rows(query, params) as never,
    get: (query, ...params) => rows(query, params)[0] as never,
    run: (query, ...params) => void rows(query, params),
    exec: (script) => void storage.sql.exec(script).toArray(),
    transaction: (fn) => storage.transactionSync(fn),
    schemaVersion: () => (rows("SELECT value FROM meta WHERE key = 'schema_version'", [])[0]?.value as number | undefined) ?? 0,
    setSchemaVersion: (v) =>
      void rows("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [v]),
  };
}

/** The shared code reads its settings from process.env, as it does on Node. */
function useSecrets(env: Env): void {
  process.env.DEEPSEEK_API_KEY ||= env.DEEPSEEK_API_KEY;
}

/** One visitor's memory and API. */
export class Visitor extends DurableObject<Env> {
  private readonly api: ReturnType<typeof createApi>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    useSecrets(env);
    const sql = durableSql(ctx.storage);
    migrate(sql);
    this.api = createApi({ store: new MemoryStore(sql), questionsPerDay: QUESTIONS_PER_VISITOR });
  }

  fetch(request: Request): Response | Promise<Response> {
    return this.api.fetch(request);
  }
}

/** The site-wide daily count of questions. One instance, named "global". */
export class Budget extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS days (day TEXT PRIMARY KEY, questions INTEGER NOT NULL)');
  }

  /** Counts `cost` questions against today. False, and nothing counted, once the day's limit is reached. */
  take(cost: number, limit: number): boolean {
    const day = new Date().toISOString().slice(0, 10);
    const used = (this.ctx.storage.sql.exec('SELECT questions FROM days WHERE day = ?', day).toArray()[0]?.questions as number) ?? 0;
    if (used + cost > limit) return false;
    this.ctx.storage.sql.exec(
      'INSERT INTO days (day, questions) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET questions = questions + excluded.questions',
      day,
      cost,
    );
    return true;
  }
}

interface Exports {
  Visitor: DurableObjectNamespace<Visitor>;
  Budget: DurableObjectNamespace<Budget>;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    // Static assets are served before the Worker runs, so only API calls get this far.
    if (!pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });
    const { Visitor, Budget } = (ctx as unknown as { exports: Exports }).exports;

    if (request.method === 'POST' && (pathname === '/api/chat' || pathname === '/api/example-history')) {
      const cost = pathname === '/api/chat' ? 1 : EXAMPLE_HISTORY_COST;
      const budget = Budget.get(Budget.idFromName('global'));
      if (!(await budget.take(cost, QUESTIONS_PER_DAY))) {
        return Response.json(
          { error: 'The demo has used its questions for today. Try again tomorrow, or run it yourself: github.com/warun7/since' },
          { status: 429 },
        );
      }
    }

    const known = cookie(request, COOKIE);
    const visitor = known && VISITOR_ID.test(known) ? known : crypto.randomUUID();
    const response = await Visitor.get(Visitor.idFromName(visitor)).fetch(request);
    if (visitor === known) return response;

    const withCookie = new Response(response.body, response);
    withCookie.headers.append('Set-Cookie', `${COOKIE}=${visitor}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`);
    return withCookie;
  },
} satisfies ExportedHandler<Env>;

function cookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return undefined;
}
