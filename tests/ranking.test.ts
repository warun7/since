// Scores the ranker alone on a recorded set of real search results, so a change to ranking
// shows up even when whole-answer evals do not move. Re-record with `npx tsx evals/ranking/record.ts`.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalUrl, mergeAndRank } from '../src/search/rank.js';
import type { RawResult } from '../src/types.js';

interface Case {
  id: string;
  hosts: string[];
  results: RawResult[];
}

const cases: Case[] = JSON.parse(readFileSync(new URL('../evals/ranking/fixture.json', import.meta.url), 'utf8'));

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};
const isOfficial = (url: string, hosts: string[]): boolean =>
  hosts.some((h) => hostOf(url) === h || hostOf(url).endsWith(`.${h}`));
/** 1-based rank of the first official page, or 0 when none is left. */
const rankOf = (urls: string[], hosts: string[]): number => {
  const i = urls.findIndex((u) => isOfficial(u, hosts));
  return i < 0 ? 0 : i + 1;
};
/** Provider order, deduplicated: the "ranker that does nothing" control. */
const providerOrder = (results: RawResult[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of results) {
    const key = canonicalUrl(r.url);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(r.url);
    }
  }
  return out;
};

const ranked = cases.map((c) => rankOf(mergeAndRank(c.results).map((r) => r.url), c.hosts));
const control = cases.map((c) => rankOf(providerOrder(c.results), c.hosts));
const mrr = (ranks: number[]): number => ranks.reduce((sum, r) => sum + (r ? 1 / r : 0), 0) / ranks.length;
const inTop3 = (ranks: number[]): number => ranks.filter((r) => r > 0 && r <= 3).length;

describe('ranking on recorded results', () => {
  it('keeps an official page in the top three for at least ten of twelve queries', () => {
    expect(cases).toHaveLength(12);
    expect(inTop3(ranked)).toBeGreaterThanOrEqual(10);
  });

  it('is never worse than the provider order a ranker that does nothing would keep', () => {
    // The control matters: without it a test that passes on any order proves nothing.
    expect(mrr(ranked)).toBeGreaterThanOrEqual(mrr(control));
  });

  it('lifts the official page where two queries disagree about it', () => {
    // The Hetzner case is why merging exists: the price query ranks the vendor 14th on its own.
    const hetzner = cases.findIndex((c) => c.id === 'hetzner-cx23');
    expect(ranked[hetzner]).toBeGreaterThan(0);
    expect(ranked[hetzner]).toBeLessThanOrEqual(4);
    expect(control[hetzner]).toBeGreaterThan(ranked[hetzner]!);
  });
});
