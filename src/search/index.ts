import type { QueryStat, RawResult, SearchOutcome, SearchProvider, SearchQuery, Source } from '../types.js';
import { TTLCache } from './cache.js';
import { DeepSeekSearch } from './deepseek.js';
import { queryTerms, selectPassages } from './passages.js';
import { mergeAndRank, type Ranked, siteOf } from './rank.js';
import type { SourceRegistry } from './registry.js';

export { DeepSeekSearch } from './deepseek.js';
export { SourceRegistry } from './registry.js';

export interface WebSearchOptions {
  question: string;
  registry: SourceRegistry;
  provider?: SearchProvider;
  signal?: AbortSignal;
  maxSources?: number;
}

const MAX_QUERIES = 8;
const NO_RESULTS =
  'No results found for these queries. Try different wording or an official site, or answer from what you know and say it could not be verified.';

let defaultProvider: SearchProvider | undefined;
// Keyed by provider and query, not by question: a repeated query within a session costs nothing.
const cache = new TTLCache<RawResult[]>();

interface QueryRun {
  hits: RawResult[];
  stat: QueryStat;
}

export async function webSearch(queries: SearchQuery[], opts: WebSearchOptions): Promise<SearchOutcome> {
  const started = Date.now();
  const qs = sanitize(queries);
  const provider = opts.provider ?? (defaultProvider ??= new DeepSeekSearch());

  // runQuery never rejects, so one failing query cannot take the others down with it.
  const lang = questionLanguage(opts.question);
  const runs = await Promise.all(qs.map((q) => runQuery(provider, q, opts.question, lang, opts.signal)));
  if (opts.signal?.aborted) throw opts.signal.reason;

  const maxSources = opts.maxSources ?? Math.min(14, 4 + 2 * qs.length);
  let ranked = mergeAndRank(runs.flatMap((r) => r.hits));
  // The provider's lang: operator is a hint it doesn't always honour, so check the script too.
  if (lang === 'en') ranked = ranked.filter((r) => !FOREIGN_SCRIPT.test(r.title));
  const top = selectTop(ranked, qs, maxSources);
  await readThinPages(provider, top, opts.signal);
  if (opts.signal?.aborted) throw opts.signal.reason;

  const terms = queryTerms(qs, opts.question);
  const sources: Source[] = [];
  for (const r of top) {
    const passages = selectPassages(r, terms);
    if (passages.length === 0) continue;
    const site = siteOf(r.url, r.siteName);
    sources.push(
      opts.registry.register({
        url: r.url,
        title: r.title || site,
        site,
        published: r.date?.match(/^\d{4}-\d{2}-\d{2}/)?.[0],
        authority: r.authority,
        passages,
      }),
    );
  }
  return { sources, perQuery: runs.map((r) => r.stat), ms: Date.now() - started };
}

/** The text the model reads as the tool result. Citation numbers are the registry's, not the rank order. */
export function formatResultsForModel(outcome: SearchOutcome): string {
  const misses = outcome.perQuery
    .filter((s) => s.hits === 0)
    .map((s) => `No results: "${s.query.q}"${s.error ? ` (${s.error})` : ''}`);
  if (outcome.sources.length === 0) return [NO_RESULTS, ...misses].join('\n');

  const blocks = outcome.sources.map((s) => {
    const tags = [s.published ? `published ${s.published}` : '', (s.authority ?? -1) >= 3 ? 'authoritative' : ''].filter(
      Boolean,
    );
    const head = `[${s.n}] ${s.title} — ${s.site}${tags.map((t) => ` · ${t}`).join('')}`;
    return [head, s.url, ...s.passages.map((p) => `> ${p}`)].join('\n');
  });

  return [
    'Search results — cite as [n]. Published dates are shown when known.',
    '',
    blocks.join('\n\n'),
    ...(misses.length ? ['', ...misses] : []),
  ].join('\n');
}

async function runQuery(
  provider: SearchProvider,
  query: SearchQuery,
  question: string,
  lang: string | undefined,
  signal?: AbortSignal,
): Promise<QueryRun> {
  const t0 = Date.now();
  const key = JSON.stringify([provider.name, query, lang]);
  const cached = cache.get(key);
  if (cached) return { hits: cached, stat: { query, hits: cached.length, ms: Date.now() - t0, cached: true } };
  try {
    const hits = await provider.search(query, { question, count: 10, lang, signal });
    cache.set(key, hits);
    return { hits, stat: { query, hits: hits.length, ms: Date.now() - t0, cached: false } };
  } catch (err) {
    return {
      hits: [],
      stat: { query, hits: 0, ms: Date.now() - t0, cached: false, error: err instanceof Error ? err.message : String(err) },
    };
  }
}

/**
 * Some top results come back with only a short summary, and are the kind of page the model needs
 * to read (a vendor's own site, or a highly authoritative source). Fetch at most two of them.
 */
async function readThinPages(provider: SearchProvider, top: Ranked[], signal?: AbortSignal): Promise<void> {
  const read = provider.fetchPage?.bind(provider);
  if (!read) return;
  const thin = top
    .filter((r) => !r.content && r.summary.length < 300 && (r.queries.some((q) => q.site) || (r.authority ?? -1) >= 3))
    .slice(0, 2);
  await Promise.all(
    thin.map(async (r) => {
      try {
        const page = await read(r.url, signal);
        if (page?.content) r.content = page.content;
      } catch {
        // The reader is an optimisation: the snippet and summary still ground the answer.
      }
    }),
  );
}

/**
 * Every query first gets its own best result, then the rest go by score. When the model checks
 * five products in one call, a product whose pages rank lower still gets read.
 */
function selectTop(ranked: Ranked[], queries: SearchQuery[], max: number): Ranked[] {
  const chosen = new Set<Ranked>();
  for (const q of queries) {
    if (chosen.size >= max) break;
    const key = JSON.stringify(q);
    const best = ranked.find((r) => !chosen.has(r) && r.queries.some((rq) => JSON.stringify(rq) === key));
    if (best) chosen.add(best);
  }
  for (const r of ranked) {
    if (chosen.size >= max) break;
    chosen.add(r);
  }
  return ranked.filter((r) => chosen.has(r));
}

/**
 * Results should be in the language the user writes in: an English question about Cloud SQL
 * pricing should not cite the German or Chinese edition of the page. Only English is detected;
 * anything else searches unfiltered, which is the provider's default.
 */
export function questionLanguage(text: string): string | undefined {
  const english = text.match(/\b(the|is|are|was|what|which|how|did|does|do|any|has|have|of|and|to|for|in|on|you|i|we|it|my|our|since|still)\b/gi);
  return english && english.length >= 2 ? 'en' : undefined;
}

/**
 * A title in another script marks a localized edition ("Cloud SQL 价格 - Mumbai"): English
 * titles of the pages we want don't contain Han, Kana, Hangul, Cyrillic, Arabic and the like.
 */
const FOREIGN_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Thai}\p{Script=Devanagari}]/u;

/** Trims whitespace, drops empty and invalid queries, normalises operators, and dedupes. */
function sanitize(queries: SearchQuery[]): SearchQuery[] {
  const seen = new Set<string>();
  const out: SearchQuery[] = [];
  for (const raw of queries) {
    const q = String(raw.q ?? '').trim();
    if (!q) continue;
    const after = raw.after?.trim();
    const site = raw.site ? hostOf(raw.site) : undefined;
    const query: SearchQuery = {
      q,
      ...(after && isIsoDate(after) ? { after } : {}),
      ...(site ? { site } : {}),
    };
    const key = JSON.stringify(query);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(query);
    if (out.length === MAX_QUERIES) break;
  }
  return out;
}

/** "neon.tech", "https://www.neon.tech/pricing" and "neon.tech/x" all become "neon.tech". */
function hostOf(site: string): string | undefined {
  try {
    const host = new URL(/^[a-z]+:\/\//i.test(site) ? site : `https://${site}`).hostname.replace(/^www\./, '');
    return host || undefined;
  } catch {
    return undefined;
  }
}

/** Checks the shape and the calendar, so "2026-02-31" is rejected rather than rolled over. */
function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}
