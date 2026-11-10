import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekSearch, buildQuery } from '../src/search/deepseek.js';
import { formatResultsForModel, webSearch } from '../src/search/index.js';
import { queryTerms, selectPassages } from '../src/search/passages.js';
import { canonicalUrl, mergeAndRank } from '../src/search/rank.js';
import { SourceRegistry } from '../src/search/registry.js';
import type { RawResult, SearchProvider, SearchQuery, Source } from '../src/types.js';

function hit(url: string, query: SearchQuery, rank: number, extra: Partial<RawResult> = {}): RawResult {
  return { url, title: `Title for ${url}`, snippet: 'snippet', summary: 'summary', content: '', query, rank, ...extra };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('canonicalUrl', () => {
  it('drops www, tracking params, fragments and trailing slashes', () => {
    expect(canonicalUrl('https://WWW.Neon.tech/pricing/?utm_source=x&plan=launch&gclid=1#faq')).toBe(
      'https://neon.tech/pricing?plan=launch',
    );
    expect(canonicalUrl('https://a.com/x?b=2&a=1&ref=feed')).toBe('https://a.com/x?a=1&b=2');
    expect(canonicalUrl('https://neon.tech/')).toBe('https://neon.tech/');
    expect(canonicalUrl('  not a url  ')).toBe('not a url');
  });
});

describe('mergeAndRank', () => {
  it('ranks a page found by two queries above one found by one, and keeps the best rerank score', () => {
    const q1: SearchQuery = { q: 'neon pricing' };
    const q2: SearchQuery = { q: 'neon plans' };
    const ranked = mergeAndRank([
      hit('https://a.com/one', q1, 0),
      hit('https://b.com/two', q1, 1, { rerankScore: 1 }),
      hit('https://www.b.com/two/', q2, 0, { rerankScore: 2.8 }),
    ]);

    expect(ranked.map((r) => r.key)).toEqual(['https://b.com/two', 'https://a.com/one']);
    expect(ranked[0].queries).toEqual([q1, q2]);
    expect(ranked[0].rerankScore).toBe(2.8);
  });

  it('caps a site at two results, or four when a query named that site', () => {
    const many = (site: string, query: SearchQuery) =>
      [0, 1, 2, 3, 4].map((i) => hit(`https://${site}/p${i}`, query, i));

    expect(mergeAndRank(many('blog.example', { q: 'x' }))).toHaveLength(2);
    expect(mergeAndRank(many('docs.example', { q: 'x', site: 'docs.example' }))).toHaveLength(4);
  });

  it('keeps low-rerank results only when fewer than three would remain', () => {
    const q: SearchQuery = { q: 'x' };
    const fewGood = mergeAndRank([
      hit('https://a.com/1', q, 0, { rerankScore: 0.2 }),
      hit('https://b.com/1', q, 1, { rerankScore: 2.5 }),
    ]);
    expect(fewGood.map((r) => r.url)).toEqual(['https://b.com/1', 'https://a.com/1']);

    const enoughGood = mergeAndRank([
      hit('https://a.com/1', q, 0, { rerankScore: 0.2 }),
      hit('https://b.com/1', q, 1, { rerankScore: 2.5 }),
      hit('https://c.com/1', q, 2, { rerankScore: 2 }),
      hit('https://d.com/1', q, 3, { rerankScore: 1.8 }),
    ]);
    expect(enoughGood.map((r) => r.url)).not.toContain('https://a.com/1');
  });
});

describe('selectPassages', () => {
  const pad = (words: number) =>
    Array.from({ length: words }, (_, i) => ['the', 'and', 'of', 'to', 'in'][i % 5]).join(' ');

  it('returns the window that contains the query terms from a long page', () => {
    const target = 'Autoscaling adds compute capacity when traffic spikes, then scales back down.';
    const content = `${pad(600)} ${target} ${pad(600)}`;
    const [passage] = selectPassages(
      { content, summary: '', snippet: '' },
      queryTerms([{ q: 'autoscaling compute' }]),
      { maxPassages: 1 },
    );
    expect(passage).toContain('Autoscaling');
  });

  it('prefers a window with a price for pricing terms', () => {
    // Both windows hold the same tokens; only the one with "$19" should win once the pricing boost applies.
    const noPrice = 'Price: nineteen per month for the plan.';
    const price = 'Price: $19 per month for the plan.';
    const content = `${noPrice} ${pad(395)} ${price} ${pad(300)}`;
    const [passage] = selectPassages({ content, summary: '', snippet: '' }, queryTerms([{ q: 'price per month plan' }]), {
      maxPassages: 1,
    });
    expect(passage).toContain('$19');
  });
});

describe('SourceRegistry', () => {
  it('keeps numbers stable and fills gaps without overwriting', () => {
    const reg = new SourceRegistry();
    const a = reg.register({ url: 'https://a.com/x?utm_source=feed', title: 'A', site: 'a.com', passages: ['p1'] });
    const b = reg.register({ url: 'https://b.com/y', title: 'B', site: 'b.com', passages: ['p2'] });
    const again = reg.register({
      url: 'https://www.a.com/x/',
      title: '',
      site: 'a.com',
      published: '2026-10-02',
      passages: ['p3'],
    });

    expect([a.n, b.n, again.n]).toEqual([1, 2, 1]);
    expect(again.passages).toEqual(['p3']);
    expect(again.title).toBe('A');
    expect(again.published).toBe('2026-10-02');
    expect(reg.get(2)?.url).toBe('https://b.com/y');
    expect(reg.added().map((s) => s.n)).toEqual([1, 2]);
  });

  it('continues numbering after existing sources', () => {
    const existing: Source[] = [{ n: 4, url: 'https://c.com/z', title: 'C', site: 'c.com', passages: ['old'] }];
    const reg = new SourceRegistry(existing);
    expect(reg.register({ url: 'https://d.com', title: 'D', site: 'd.com', passages: ['new'] }).n).toBe(5);
    expect(reg.byUrl('https://www.c.com/z/')?.n).toBe(4);
    expect(reg.all().map((s) => s.n)).toEqual([4, 5]);
    expect(reg.added().map((s) => s.n)).toEqual([5]);
  });
});

describe('buildQuery', () => {
  it('renders the site and date operators without duplicating ones already in the text', () => {
    expect(buildQuery({ q: 'neon pricing site:neon.tech', site: 'neon.tech', after: '2026-01-01' })).toBe(
      'neon pricing site:neon.tech after:2026-01-01',
    );
    expect(buildQuery({ q: '  neon   pricing  ', site: 'neon.tech' })).toBe('neon pricing site:neon.tech');
  });

  it('stays within 128 characters and keeps the operators when the text is long', () => {
    const out = buildQuery({ q: 'word '.repeat(60), after: '2026-01-01' });
    expect(out.length).toBeLessThanOrEqual(128);
    expect(out.endsWith(' after:2026-01-01')).toBe(true);
  });
});

describe('webSearch', () => {
  it('keeps the sources of the queries that worked when one query fails', async () => {
    const provider: SearchProvider = {
      name: 'fake-partial',
      async search(query) {
        if (query.q === 'neon fails') throw new Error('upstream 500');
        return [hit('https://neon.tech/pricing', query, 0, { summary: 'Launch plan costs $19 per month.' })];
      },
    };

    const out = await webSearch([{ q: 'neon pricing' }, { q: 'neon fails' }], {
      question: 'How much is Neon?',
      registry: new SourceRegistry(),
      provider,
    });

    expect(out.sources).toHaveLength(1);
    expect(out.sources[0]).toMatchObject({ n: 1, url: 'https://neon.tech/pricing', site: 'neon.tech' });
    expect(out.sources[0].passages).toEqual(['Launch plan costs $19 per month.']);
    expect(out.perQuery.find((s) => s.query.q === 'neon fails')).toMatchObject({
      hits: 0,
      cached: false,
      error: 'upstream 500',
    });
    expect(formatResultsForModel(out)).toContain('No results: "neon fails" (search failed)');
  });

  it('serves a repeated query from the cache', async () => {
    const search = vi.fn(async (query: SearchQuery) => [
      hit('https://cache.example/page', query, 0, { summary: 'cached page text' }),
    ]);
    const provider: SearchProvider = { name: 'fake-cache', search };
    const queries = [{ q: 'cache test query unique' }];

    const first = await webSearch(queries, { question: '', registry: new SourceRegistry(), provider });
    const second = await webSearch(queries, { question: '', registry: new SourceRegistry(), provider });

    expect(search).toHaveBeenCalledTimes(1);
    expect(first.perQuery[0].cached).toBe(false);
    expect(second.perQuery[0].cached).toBe(true);
    expect(second.sources[0].passages).toEqual(['cached page text']);
  });

  it('rethrows when the caller aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider: SearchProvider = {
      name: 'fake-abort',
      async search() {
        throw new DOMException('aborted', 'AbortError');
      },
    };

    await expect(
      webSearch([{ q: 'abort me' }], {
        question: '',
        registry: new SourceRegistry(),
        provider,
        signal: controller.signal,
      }),
    ).rejects.toBeDefined();
  });

  it('reports a clear message when nothing is found', () => {
    const text = formatResultsForModel({ sources: [], perQuery: [], ms: 0 });
    expect(text).toContain('No results found for these queries.');
  });
});

describe('DeepSeekSearch', () => {
  const baseUrl = 'https://example.test';

  it('maps the search response and retries once on 429', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{"error":{"message":"Rate limit reached","type":"rate_limit_error","code":"rate_limit"}}', {
          status: 429,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                url: 'https://neon.tech/pricing',
                title: 'Neon Pricing',
                snippet: 'Plans and prices',
                summary: 'Launch plan details',
                content: '',
                site_name: null,
                site_icon: null,
                date: '2026-10-02T00:00:00Z',
                rerank_score: 2.4,
                authority: 4,
              },
              { url: '', title: 'no url, skipped' },
            ],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new DeepSeekSearch({ apiKey: 'test-key', baseUrl });
    const query: SearchQuery = { q: 'neon pricing', site: 'neon.tech' };
    const results = await provider.search(query, { question: 'How much is Neon?' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(`${baseUrl}/v1/tools/search`);
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-key' });
    expect(JSON.parse(init.body as string)).toMatchObject({
      query: 'neon pricing site:neon.tech',
      count: 10,
      need_content: true,
      ori_question: 'How much is Neon?',
    });
    expect(results).toEqual([
      {
        url: 'https://neon.tech/pricing',
        title: 'Neon Pricing',
        snippet: 'Plans and prices',
        summary: 'Launch plan details',
        content: '',
        siteName: undefined,
        date: '2026-10-02T00:00:00.000Z',
        rerankScore: 2.4,
        authority: 4,
        query,
        rank: 0,
      },
    ]);
  });

  it('returns null from fetchPage when the page is blocked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"blocked"}}', { status: 403 })));
    const provider = new DeepSeekSearch({ apiKey: 'test-key', baseUrl });
    expect(await provider.fetchPage('https://example.test/private')).toBeNull();
  });
});

describe('canonicalUrl click ids', () => {
  it('treats UUID-valued parameters as the same page', async () => {
    const { canonicalUrl } = await import('../src/search/rank.js');
    expect(canonicalUrl('https://neon.com/faqs/x?a=d22ee1c6-e1fe-4773-a5b1-45c8e72c028a')).toBe(canonicalUrl('https://neon.com/faqs/x'));
    expect(canonicalUrl('https://example.com/item?id=42')).toContain('id=42');
  });
});

describe('language filter', () => {
  it('detects English questions and adds the operator after the others', async () => {
    const { questionLanguage } = await import('../src/search/index.js');
    const { buildQuery } = await import('../src/search/deepseek.js');
    expect(questionLanguage('Has any pricing changed since then?')).toBe('en');
    expect(questionLanguage('Neon 价格是多少')).toBeUndefined();
    expect(buildQuery({ q: 'pricing', site: 'neon.com' }, 'en')).toBe('pricing site:neon.com lang:en');
  });
});

describe('script filter', () => {
  it('drops non-Latin pages for English questions only', async () => {
    const { webSearch, SourceRegistry } = await import('../src/search/index.js');
    const hit = (url: string, title: string) => ({ url, title, snippet: title, summary: '', content: `${title} `.repeat(5), query: { q: 'x' }, rank: 0 });
    const provider = { name: 'fake-script', search: async () => [hit('https://a.com/en', 'Cloud SQL pricing'), hit('https://a.com/zh', 'Cloud SQL 价格 价格 价格')] };
    const en = await webSearch([{ q: 'cloud sql pricing' }], { question: 'What is the price of the Cloud SQL micro tier?', registry: new SourceRegistry(), provider });
    expect(en.sources.map((s) => s.url)).toEqual(['https://a.com/en']);
  });
});
