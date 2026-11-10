// `npm run dev`: the API plus the UI on one Node server, with memory in one SQLite file.
import 'dotenv/config';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApi } from './app.js';
import { assertConfig, config } from './config.js';
import { openStore } from './memory/db.js';

assertConfig();
const app = createApi({ store: openStore() });

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
