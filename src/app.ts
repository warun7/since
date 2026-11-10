// The HTTP API. `npm run dev` (server.ts) and the hosted Worker (cloud/worker.ts) both serve
// it, each with its own store: one SQLite file locally, one Durable Object per visitor online.
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { runTurn } from './agent/orchestrator.js';
import { config } from './config.js';
import { demoSeeds, seedDemoHistory } from './demo/seed.js';
import type { MemoryStore } from './memory/store.js';
import type { AgentEvent } from './types.js';
import { upheldEnabled, upheldHealth } from './verify/upheld.js';

export interface ApiOptions {
  store: MemoryStore;
  /** Questions allowed in any 24 hours, counted in this store. Unlimited when unset, as it is locally. */
  questionsPerDay?: number;
  /**
   * Asked once a request has passed every other check, just before it spends `cost` questions.
   * Resolves to a reason to refuse, or null to go ahead. The hosted demo meters its per-network
   * and site-wide daily limits here, so a malformed or refused request never uses them up.
   */
  admit?: (cost: number, request: Request) => Promise<string | null>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGE_CHARS = 8000;

type ChatBody = { conversationId?: string; message?: string; tz?: string };

/** The question in a chat request's body, or why there isn't a usable one. */
export function chatMessage(body: unknown): string | { error: string; status: 400 | 413 } {
  const raw = (body as ChatBody | null)?.message;
  const message = typeof raw === 'string' ? raw.trim() : '';
  if (!message) return { error: 'message is required', status: 400 };
  if (message.length > MAX_MESSAGE_CHARS) return { error: 'message is too long', status: 413 };
  return message;
}

export function createApi({ store, questionsPerDay, admit }: ApiOptions): Hono {
  const app = new Hono();

  // One person's data: never kept in a cache.
  app.use('/api/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  // Changes come only from this site's own pages.
  app.use('/api/*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && crossSite(c.req.raw)) {
      return c.json({ error: 'Cross-site request refused.' }, 403);
    }
    await next();
  });
  app.use('/api/*', bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: 'request is too large' }, 413) }));

  app.get('/api/health', async (c) =>
    c.json({ ok: true, model: config.chatModel, search: 'deepseek', upheld: upheldEnabled() && (await upheldHealth()) }),
  );

  app.get('/api/conversations', (c) => c.json({ conversations: store.listConversations() }));

  app.get('/api/conversations/:id', (c) => {
    const conversation = store.getConversation(c.req.param('id'));
    if (!conversation) return c.json({ error: 'not found' }, 404);
    return c.json({ conversation, messages: store.getMessages(conversation.id) });
  });

  // Forget everything: every conversation, with its messages, sources and memory notes.
  app.delete('/api/conversations', (c) => {
    store.clearAll();
    return c.json({ ok: true });
  });

  app.delete('/api/conversations/:id', (c) => {
    store.deleteConversation(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/api/chat', async (c) => {
    const body = ((await c.req.json().catch(() => null)) ?? {}) as ChatBody;
    const message = chatMessage(body);
    if (typeof message !== 'string') return c.json({ error: message.error }, message.status);
    if (questionsPerDay && store.questionsSince(new Date(Date.now() - DAY_MS).toISOString()) >= questionsPerDay) {
      return c.json({ error: `This demo allows ${questionsPerDay} questions a day. Run it yourself for more: github.com/warun7/since` }, 429);
    }
    const refused = await admit?.(1, c.req.raw);
    if (refused) return c.json({ error: refused }, 429);

    return streamSSE(c, async (stream) => {
      const abort = new AbortController();
      stream.onAbort(() => abort.abort());
      // Events are emitted synchronously by the agent; chain the writes to keep their order.
      let writes = Promise.resolve();
      const emit = (e: AgentEvent) => {
        writes = writes.then(() => (stream.aborted ? undefined : stream.writeSSE({ data: JSON.stringify(e) })));
      };
      try {
        await runTurn(
          {
            conversationId: body.conversationId || undefined,
            message,
            clock: { now: new Date(), tz: body.tz || config.defaultTz },
            signal: abort.signal,
          },
          emit,
          { store },
        );
      } catch (err) {
        if (!abort.signal.aborted) console.error('[turn]', err);
      }
      await writes;
    });
  });

  // Example history, so the memory questions can be tried at once. Only into an empty memory,
  // and only once at a time: a double click must not seed twice.
  let seeding: Promise<Response> | null = null;
  app.post('/api/example-history', async (c) => {
    const body = ((await c.req.json().catch(() => null)) ?? {}) as { tz?: string };
    if (seeding || store.firstTurnAt()) return c.json({ error: 'Example history can only be added to an empty memory.' }, 409);
    seeding = (async () => {
      const tz = body.tz || config.defaultTz;
      const refused = await admit?.(demoSeeds(new Date(), tz).length, c.req.raw);
      if (refused) return c.json({ error: refused }, 429);
      const results = await seedDemoHistory(store, { tz });
      const failed = results.filter((r) => r.error);
      for (const r of failed) console.error('[example-history]', r.seed.label, r.error);
      return c.json({ added: results.length - failed.length, failed: failed.length }, failed.length === results.length ? 502 : 200);
    })().finally(() => {
      seeding = null;
    });
    return seeding;
  });

  return app;
}

/**
 * Browsers label every request with Sec-Fetch-Site (older ones send Origin). A request with
 * neither isn't from a browser, so it carries no visitor's cookie to misuse.
 */
export function crossSite(request: Request): boolean {
  const site = request.headers.get('Sec-Fetch-Site');
  if (site) return site !== 'same-origin' && site !== 'none';
  const origin = request.headers.get('Origin');
  return origin !== null && origin !== new URL(request.url).origin;
}
