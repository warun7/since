// Records the search results the ranking eval scores, once, so the test needs no network.
// Usage: npx tsx evals/ranking/record.ts   (costs one Search API request per query)
// Each case names the host an official page for that query lives on; the test checks that
// mergeAndRank puts one of them in the top three.
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeepSeekSearch } from '../../src/search/deepseek.js';
import type { SearchQuery } from '../../src/types.js';

interface Case {
  id: string;
  queries: SearchQuery[];
  hosts: string[];
}

export const CASES: Case[] = [
  { id: 'neon-pricing', queries: [{ q: 'pricing plans', site: 'neon.tech' }, { q: 'Neon Launch plan price 2026' }], hosts: ['neon.com', 'neon.tech'] },
  { id: 'supabase-pricing', queries: [{ q: 'pricing', site: 'supabase.com' }], hosts: ['supabase.com'] },
  { id: 'render-postgres', queries: [{ q: 'postgres pricing', site: 'render.com' }], hosts: ['render.com'] },
  { id: 'hetzner-cx23', queries: [{ q: 'CX23 price per month' }, { q: 'Hetzner Cloud pricing CX23' }], hosts: ['hetzner.com'] },
  { id: 'node-lts', queries: [{ q: 'latest Node.js LTS version' }], hosts: ['nodejs.org'] },
  { id: 'postgres-17', queries: [{ q: 'PostgreSQL 17 release notes' }], hosts: ['postgresql.org'] },
  { id: 'cloudflare-workers', queries: [{ q: 'Cloudflare Workers pricing' }], hosts: ['cloudflare.com'] },
  { id: 'linear-pricing', queries: [{ q: 'Linear pricing plans' }], hosts: ['linear.app'] },
  { id: 'stripe-fees', queries: [{ q: 'Stripe pricing fees' }, { q: 'Stripe card processing fee 2026' }], hosts: ['stripe.com'] },
  { id: 'fly-io', queries: [{ q: 'Fly.io pricing' }], hosts: ['fly.io'] },
  { id: 'docker-pricing', queries: [{ q: 'Docker subscription pricing' }], hosts: ['docker.com'] },
  { id: 'anthropic-pricing', queries: [{ q: 'Claude API pricing' }], hosts: ['anthropic.com', 'claude.com'] },
];

const provider = new DeepSeekSearch();
const out: Array<Case & { results: unknown[] }> = [];
for (const c of CASES) {
  const results = [];
  for (const query of c.queries) {
    try {
      const hits = await provider.search(query, { count: 10 });
      // Only what ranking reads: the page text is not part of this eval.
      results.push(...hits.map(({ url, title, siteName, date, authority, rerankScore, query: q, rank }) => ({ url, title, siteName, date, authority, rerankScore, query: q, rank, content: '', summary: '', snippet: '' })));
    } catch (err) {
      console.error(`  ${c.id}: query failed — ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`  ${c.id}: ${results.length} results`);
  out.push({ ...c, results });
}

const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(here, 'fixture.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${join(here, 'fixture.json')}`);
