// The HTTP API. `npm run dev` (server.ts) and the hosted Worker (cloud/worker.ts) both serve
// it, each with its own store: one SQLite file locally, one Durable Object per visitor online.
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { runTurn } from './agent/orchestrator.js';
import { config } from './config.js';
import { seedDemoHistory } from './demo/seed.js';
import type { MemoryStore } from './memory/store.js';
import type { AgentEvent } from './types.js';
import { upheldEnabled, upheldHealth } from './verify/upheld.js';

export interface ApiOptions {
  store: MemoryStore;
  /** Questions allowed in any 24 hours. Unlimited when unset, as it is locally. */
  questionsPerDay?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function createApi({ store, questionsPerDay }: ApiOptions): Hono {
  const app = new Hono();

  app.get('/api/health', async (c) =>
    c.json({ ok: true, model: config.chatModel, search: 'deepseek', upheld: upheldEnabled() && (await upheldHealth()) }),
  );

  app.get('/api/conversations', (c) => c.json({ conversations: store.listConversations() }));

  app.get('/api/conversations/:id', (c) => {
    const conversation = store.getConversation(c.req.param('id'));
    if (!conversation) return c.json({ error: 'not found' }, 404);
    return c.json({ conversation, messages: store.getMessages(conversation.id) });
  });

  app.delete('/api/conversations/:id', (c) => {
    store.deleteConversation(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/api/chat', async (c) => {
    const body = await c.req.json<{ conversationId?: string; message?: string; tz?: string }>().catch(() => ({}) as Record<string, never>);
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) return c.json({ error: 'message is required' }, 400);
    if (message.length > 8000) return c.json({ error: 'message is too long' }, 413);
    if (questionsPerDay && store.questionsSince(new Date(Date.now() - DAY_MS).toISOString()) >= questionsPerDay) {
      return c.json({ error: `This demo allows ${questionsPerDay} questions a day. Run it yourself for more: github.com/warun7/since` }, 429);
    }

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
    const body = await c.req.json<{ tz?: string }>().catch(() => ({}) as Record<string, never>);
    if (seeding || store.firstTurnAt()) return c.json({ error: 'Example history can only be added to an empty memory.' }, 409);
    seeding = (async () => {
      const results = await seedDemoHistory(store, { tz: body.tz || config.defaultTz });
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
