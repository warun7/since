import type { RawResult, SearchQuery } from '../types.js';

// Reciprocal rank fusion constant. Each query returns only 5-10 hits, so a small k keeps the
// top hit of each query clearly ahead of the tail.
const RRF_K = 10;
// Provider scores below this are off-topic. They survive only when too few results remain.
const MIN_RERANK = 0.6;
const MIN_KEPT = 3;
const SITE_CAP = 2;
// A site a query asked for by name is expected to dominate, so it gets more room.
const TARGETED_SITE_CAP = 4;

/** Query-string keys that identify the referrer, not the page. */
const TRACKING = /^(utm_.+|gclid|fbclid|mc_cid|mc_eid|ref|ref_src)$/i;
/** A UUID-valued parameter is a click or session id: "?a=d22ee1c6-..." is the same page as without it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Ranked extends RawResult {
  key: string;
  score: number;
  queries: SearchQuery[];
}

/** The same page reached through different URLs must merge into one hit. */
export function canonicalUrl(url: string): string {
  const raw = url.trim();
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  // URL already lowercases special-scheme hosts; the explicit call documents the intent.
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  u.hash = '';
  const params = [...u.searchParams]
    .filter(([key, value]) => !TRACKING.test(key) && !UUID.test(value))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = new URLSearchParams(params).toString();
  if (u.pathname !== '/') u.pathname = u.pathname.replace(/\/+$/, '') || '/';
  return u.toString();
}

/** Hostname without "www.". The site name is only a display fallback for unparseable URLs. */
export function siteOf(url: string, siteName?: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return siteName?.trim() || url.trim();
  }
}

/**
 * Merges hits for the same page, scores them by fusion across queries, drops off-topic hits,
 * and caps how many results one site can take so a single domain cannot fill the list.
 */
export function mergeAndRank(results: RawResult[]): Ranked[] {
  const byKey = new Map<string, Ranked>();
  for (const r of results) {
    const key = canonicalUrl(r.url);
    const share = 1 / (RRF_K + r.rank);
    const cur = byKey.get(key);
    if (!cur) {
      byKey.set(key, { ...r, key, score: share, queries: [r.query] });
      continue;
    }
    cur.score += share;
    cur.title ||= r.title;
    cur.date ||= r.date;
    cur.siteName ||= r.siteName;
    // The longest text is the most informative copy; providers vary in how much they return.
    if (r.content.length > cur.content.length) cur.content = r.content;
    if (r.summary.length > cur.summary.length) cur.summary = r.summary;
    if (r.snippet.length > cur.snippet.length) cur.snippet = r.snippet;
    cur.rerankScore = maxOf(cur.rerankScore, r.rerankScore);
    cur.authority = maxOf(cur.authority, r.authority);
    if (!cur.queries.some((q) => sameQuery(q, r.query))) cur.queries.push(r.query);
  }

  const ranked = [...byKey.values()];
  for (const r of ranked) {
    const authority = r.authority ?? -1;
    const authorityBoost = authority >= 3 ? 1 : authority === 2 ? 0.5 : 0;
    r.score += 0.15 * clamp01((r.rerankScore ?? 1) / 3) + 0.05 * authorityBoost;
  }
  ranked.sort((a, b) => b.score - a.score);

  const good = (r: Ranked) => r.rerankScore === undefined || r.rerankScore >= MIN_RERANK;
  let kept = ranked.filter(good);
  if (kept.length < MIN_KEPT) {
    // Keep every good hit and fill up to MIN_KEPT with the best off-topic ones, so a thin
    // result set still gives the model something to read.
    const rescued = ranked.filter((r) => !good(r)).slice(0, MIN_KEPT - kept.length);
    kept = ranked.filter((r) => good(r) || rescued.includes(r));
  }

  const targets = new Set(results.flatMap((r) => (r.query.site ? [siteHost(r.query.site)] : [])));
  const perSite = new Map<string, number>();
  return kept.filter((r) => {
    const site = siteOf(r.url, r.siteName);
    const cap = [...targets].some((t) => isUnder(site, t)) ? TARGETED_SITE_CAP : SITE_CAP;
    const n = perSite.get(site) ?? 0;
    if (n >= cap) return false;
    perSite.set(site, n + 1);
    return true;
  });
}

function maxOf(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined ? b : b === undefined ? a : Math.max(a, b);
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function sameQuery(a: SearchQuery, b: SearchQuery): boolean {
  return JSON.stringify([a.q, a.after ?? null, a.site ?? null]) === JSON.stringify([b.q, b.after ?? null, b.site ?? null]);
}

const siteHost = (site: string) => site.trim().toLowerCase().replace(/^www\./, '');
const isUnder = (site: string, host: string) => site === host || site.endsWith(`.${host}`);
