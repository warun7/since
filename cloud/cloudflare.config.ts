import { bindings, defineConfig, exports } from 'cf/config';
import * as entrypoint from './worker.ts' with { type: 'cf-worker' };

export default defineConfig({
  worker: {
    name: 'since',
    entrypoint,
    compatibilityDate: '2026-10-01',
    // nodejs_compat: the shared code uses process.env. enable_ctx_exports: the Worker reaches
    // its own Durable Object classes through ctx.exports, with no bindings to declare.
    compatibilityFlags: ['nodejs_compat', 'enable_ctx_exports'],
    exports: {
      Visitor: exports.durableObject({ storage: 'sqlite' }),
      Budget: exports.durableObject({ storage: 'sqlite' }),
    },
    // The Worker runs first for every request, assets too, so every response gets its security
    // headers and the workers.dev address can redirect to the canonical one.
    assets: { runWorkerFirst: true },
    env: {
      DEEPSEEK_API_KEY: bindings.secret(),
      ASSETS: bindings.assets(),
      API_RATE: bindings.rateLimit({ namespace: '1001', simple: { limit: 30, period: 60 } }),
      // Your copy: set this to its own address, or remove it to serve from workers.dev.
      CANONICAL_ORIGIN: bindings.text('https://since.varunsg.com'),
    },
    observability: { enabled: true },
  },
});
