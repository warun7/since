// The hosted demo on Cloudflare. A Worker in front gives each visitor an id (a cookie) and
// forwards their API calls to that visitor's own Durable Object. The Durable Object keeps
// the visitor's memory in its built-in SQLite and serves the same API and MemoryStore as
// `npm run dev`, so visitors never see each other's history. The UI is static assets.
import { DurableObject } from 'cloudflare:workers';
import type { Hono } from 'hono';
import { createApi } from '../src/app.js';
import { SECURITY_HEADERS } from '../src/headers.js';
import { migrate } from '../src/memory/schema.js';
import type { Sql } from '../src/memory/sql.js';
import { MemoryStore } from '../src/memory/store.js';

interface Env {
  DEEPSEEK_API_KEY: string;
  ASSETS: Fetcher;
  /** API requests per network per minute, checked before anything else. */
  API_RATE: RateLimit;
  /** The demo's one public address. Requests to the workers.dev address are sent there. */
  CANONICAL_ORIGIN?: string;
}

/** Per visitor, in any 24 hours. */
const QUESTIONS_PER_VISITOR = 40;
/** Per network (IP address), per UTC day. A new cookie doesn't reset this one. */
const QUESTIONS_PER_NETWORK = 60;
/** Across all visitors, per UTC day: a ceiling on what the demo can spend. */
const QUESTIONS_PER_DAY = 1500;
const RUN_IT_YOURSELF = 'Run it yourself for more: github.com/warun7/since';

/** A memory is deleted this long after its last visit, and one with nothing in it much sooner. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const KEEP_EMPTY_MS = 60 * 60 * 1000;

// __Host-: only this exact origin, over HTTPS, can set it, so no other varunsg.com host can
// plant a known id in a visitor's browser.
const COOKIE = '__Host-since_visitor';
const VISITOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Exports {
  Visitor: DurableObjectNamespace<Visitor>;
  Budget: DurableObjectNamespace<Budget>;
}
const exportsOf = (ctx: ExecutionContext | DurableObjectState) => (ctx as unknown as { exports: Exports }).exports;

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
    schemaVersion: () => meta(storage, 'schema_version') ?? 0,
    setSchemaVersion: (v) => setMeta(storage, 'schema_version', v),
  };
}

const meta = (storage: DurableObjectStorage, key: string) =>
  storage.sql.exec('SELECT value FROM meta WHERE key = ?', key).toArray()[0]?.value as number | undefined;
const setMeta = (storage: DurableObjectStorage, key: string, value: number) =>
  void storage.sql.exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);

/** The shared code reads its settings from process.env, as it does on Node. */
function useSecrets(env: Env): void {
  process.env.DEEPSEEK_API_KEY ||= env.DEEPSEEK_API_KEY;
}

/** One visitor's memory and API. */
export class Visitor extends DurableObject<Env> {
  private open?: { store: MemoryStore; api: Hono };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    useSecrets(env);
  }

  /** Opened on first use, and again after the alarm has deleted everything. */
  private memory(): { store: MemoryStore; api: Hono } {
    if (!this.open) {
      const sql = durableSql(this.ctx.storage);
      migrate(sql);
      const store = new MemoryStore(sql);
      const api = createApi({ store, questionsPerDay: QUESTIONS_PER_VISITOR, admit: (cost, request) => this.admit(cost, request) });
      this.open = { store, api };
    }
    return this.open;
  }

  async fetch(request: Request): Promise<Response> {
    const { api } = this.memory();
    setMeta(this.ctx.storage, 'last_seen', Date.now());
    // The alarm decides, when it fires, whether to keep this memory for longer.
    await this.ctx.storage.setAlarm(Date.now() + KEEP_EMPTY_MS);
    return api.fetch(request);
  }

  async alarm(): Promise<void> {
    const { store } = this.memory();
    const keep = store.isEmpty() ? KEEP_EMPTY_MS : KEEP_MS;
    const lastSeen = meta(this.ctx.storage, 'last_seen') ?? 0;
    if (Date.now() - lastSeen < keep) {
      await this.ctx.storage.setAlarm(lastSeen + keep);
      return;
    }
    await this.ctx.storage.deleteAll();
    this.open = undefined;
  }

  /** The site-wide and per-network daily limits, charged only for a request about to run. */
  private async admit(cost: number, request: Request): Promise<string | null> {
    const network = await hash(request.headers.get('CF-Connecting-IP') ?? 'unknown');
    const { Budget } = exportsOf(this.ctx);
    return Budget.get(Budget.idFromName('global')).take(cost, network);
  }
}

/** Daily question counts: one row for the whole site, one per network. One instance, "global". */
export class Budget extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec('DROP TABLE IF EXISTS days');
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS usage (day TEXT NOT NULL, key TEXT NOT NULL, questions INTEGER NOT NULL, PRIMARY KEY (day, key))',
    );
  }

  /** Counts `cost` questions against today, or returns why not (and counts nothing). */
  take(cost: number, network: string): string | null {
    const sql = this.ctx.storage.sql;
    const day = new Date().toISOString().slice(0, 10);
    const used = (key: string) =>
      (sql.exec('SELECT questions FROM usage WHERE day = ? AND key = ?', day, key).toArray()[0]?.questions as number | undefined) ?? 0;
    if (used('*') + cost > QUESTIONS_PER_DAY) return `The demo has used its questions for today. Try again tomorrow. ${RUN_IT_YOURSELF}`;
    if (used(network) + cost > QUESTIONS_PER_NETWORK) {
      return `This demo allows ${QUESTIONS_PER_NETWORK} questions a day from one network. ${RUN_IT_YOURSELF}`;
    }
    for (const key of ['*', network]) {
      sql.exec(
        'INSERT INTO usage (day, key, questions) VALUES (?, ?, ?) ON CONFLICT (day, key) DO UPDATE SET questions = questions + excluded.questions',
        day,
        key,
        cost,
      );
    }
    sql.exec('DELETE FROM usage WHERE day < ?', day);
    return null;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // One public address, so each person has one cookie and one memory.
    if (env.CANONICAL_ORIGIN && url.hostname.endsWith('.workers.dev')) {
      return Response.redirect(`${env.CANONICAL_ORIGIN}${url.pathname}${url.search}`, 301);
    }
    const response = withSecurityHeaders(await route(request, url, env, ctx));
    if (url.pathname.startsWith('/api/')) response.headers.set('Cache-Control', 'no-store');
    return response;
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
  if (url.pathname === '/api/health') return Response.json({ ok: true });

  const network = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (!(await env.API_RATE.limit({ key: network })).success) {
    return Response.json({ error: 'Too many requests. Wait a minute and try again.' }, { status: 429 });
  }

  const known = cookie(request, COOKIE);
  const visitor = known && VISITOR_ID.test(known) ? known : null;
  if (!visitor) {
    // Nothing stored yet, so nothing to read or delete: answer without creating a memory.
    if (request.method === 'GET' && url.pathname === '/api/conversations') return Response.json({ conversations: [] });
    if (request.method !== 'POST') return Response.json({ error: 'not found' }, { status: 404 });
  }

  const id = visitor ?? crypto.randomUUID();
  const { Visitor } = exportsOf(ctx);
  const response = await Visitor.get(Visitor.idFromName(id)).fetch(request);
  if (visitor) return response;

  const withCookie = new Response(response.body, response);
  withCookie.headers.append('Set-Cookie', `${COOKIE}=${id}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Strict`);
  return withCookie;
}

function withSecurityHeaders(response: Response): Response {
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) secured.headers.set(name, value);
  secured.headers.set('Strict-Transport-Security', 'max-age=31536000');
  return secured;
}

/** The last cookie of that name wins. */
function cookie(request: Request, name: string): string | undefined {
  let found: string | undefined;
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) found = value.join('=');
  }
  return found;
}

/** Networks are counted by a hash of the address, not the address itself. */
async function hash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
