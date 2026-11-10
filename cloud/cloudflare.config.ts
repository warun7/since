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
    env: {
      DEEPSEEK_API_KEY: bindings.secret(),
    },
    observability: { enabled: true },
  },
});
