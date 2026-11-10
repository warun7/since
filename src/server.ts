import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { assertConfig, config } from './config.js';
import { getStore, runTurn } from './agent/orchestrator.js';
import type { AgentEvent } from './types.js';
import { upheldEnabled, upheldHealth } from './verify/upheld.js';

assertConfig();
const app = new Hono();
const store = getStore();

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
      );
    } catch (err) {
      if (!abort.signal.aborted) console.error('[turn]', err);
    }
    await writes;
  });
});

// The UI: static files, plus two browser modules served straight from node_modules (no build step).
// no-cache means "revalidate", so an edited app.js is picked up on the next load.
app.use('/*', async (c, next) => {
  await next();
  if (!c.req.path.startsWith('/api/')) c.header('Cache-Control', 'no-cache');
});
app.get('/vendor/marked.esm.js', serveStatic({ path: './node_modules/marked/lib/marked.esm.js' }));
app.get('/vendor/purify.es.mjs', serveStatic({ path: './node_modules/dompurify/dist/purify.es.mjs' }));
app.use('/*', serveStatic({ root: './web' }));

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`\n  since is running at http://localhost:${info.port}`);
  console.log(`  model ${config.chatModel} · search deepseek · memory ${config.dbPath}${config.upheldUrl ? ` · upheld ${config.upheldUrl}` : ''}\n`);
});
