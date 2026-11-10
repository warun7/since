// `npm run dev`: the API plus the UI on one Node server, with memory in one SQLite file.
import 'dotenv/config';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { createApi } from './app.js';
import { assertConfig, config } from './config.js';
import { SECURITY_HEADERS } from './headers.js';
import { openStore } from './memory/db.js';

assertConfig();

// This machine only, unless HOST says otherwise: the server has no login, and every question
// spends the DeepSeek key.
const host = process.env.HOST || '127.0.0.1';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const app = new Hono();
app.use('/*', async (c, next) => {
  // Bound to loopback, answer only to a loopback name: a web page that points its own domain
  // at 127.0.0.1 (DNS rebinding) is turned away.
  if (LOOPBACK.has(host) && !LOOPBACK.has((c.req.header('host') ?? '').replace(/:\d+$/, ''))) {
    return c.text('Forbidden', 403);
  }
  await next();
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value);
  // no-cache means "revalidate", so an edited app.js is picked up on the next load.
  if (!c.req.path.startsWith('/api/')) c.header('Cache-Control', 'no-cache');
});
app.route('/', createApi({ store: openStore() }));

// The UI: static files, plus two browser modules served straight from node_modules (no build step).
app.get('/vendor/marked.esm.js', serveStatic({ path: './node_modules/marked/lib/marked.esm.js' }));
app.get('/vendor/purify.es.mjs', serveStatic({ path: './node_modules/dompurify/dist/purify.es.mjs' }));
app.use('/*', serveStatic({ root: './web' }));

serve({ fetch: app.fetch, port: config.port, hostname: host }, (info) => {
  const shown = LOOPBACK.has(host) ? 'localhost' : host;
  console.log(`\n  since is running at http://${shown}:${info.port}`);
  console.log(`  model ${config.chatModel} · search deepseek · memory ${config.dbPath}${config.upheldUrl ? ` · upheld ${config.upheldUrl}` : ''}\n`);
});
