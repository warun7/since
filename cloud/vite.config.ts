import { cloudflare } from '@cloudflare/vite-plugin';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The UI is the repo's web/ folder plus two browser modules from the root node_modules: the
// same files `npm run dev` serves. They're gathered into one folder of static assets.
const path = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const assets = path('./.assets/');
rmSync(assets, { recursive: true, force: true });
cpSync(path('../web/'), assets, { recursive: true });
mkdirSync(`${assets}vendor`, { recursive: true });
cpSync(path('../node_modules/marked/lib/marked.esm.js'), `${assets}vendor/marked.esm.js`);
cpSync(path('../node_modules/dompurify/dist/purify.es.mjs'), `${assets}vendor/purify.es.mjs`);

export default defineConfig({
  publicDir: assets,
  // The Worker imports the agent from ../src.
  server: { fs: { allow: [path('../')] } },
  plugins: [cloudflare()],
});
