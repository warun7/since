import { afterEach, describe, expect, it, vi } from 'vitest';
import { upheldEnabled, upheldHealth, verifyAnswer } from '../src/verify/upheld.js';
import type { Source } from '../src/types.js';

const URL_BASE = 'http://127.0.0.1:8000';

function source(n: number, passages: string[]): Source {
  return { n, url: `https://example.com/${n}`, title: `Source ${n}`, site: 'example.com', passages };
}

const input = {
  question: 'What does Neon cost?',
  answer: 'Neon Launch is $19/month [1].',
  sources: [source(1, ['Launch plan: $19/month.', 'Autoscaling included.']), source(2, [])],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const report = {
  verifier: 'test-verifier@0.5',
  retrieval: 'bm25',
  summary: { claims: 4, cited_claims: 3, supported_claims: 1, citations_checked: 3, citation_verdicts: {}, claim_verdicts: {} },
  claims: [
    { text: 'Launch is $19/month.', verdict: 'supported', cited: ['1'], checks: [{ source_id: '1', verdict: 'supported' }] },
    {
      text: 'Pro is $25/month.',
      verdict: 'unsupported',
      cited: ['2'],
      checks: [{ source_id: '2', verdict: 'unsupported', note: 'Passage gives no price.' }],
    },
    { text: 'Hobby is free.', verdict: 'wrong_entity', cited: ['1'], checks: [{ source_id: '1', verdict: 'wrong_entity' }], note: 'Hobby not in source.' },
    { text: 'It is fast.', verdict: 'uncited', cited: [], checks: [] },
  ],
  sources: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('upheldEnabled', () => {
  it('is false for an empty URL and true for a set one', () => {
    expect(upheldEnabled('')).toBe(false);
    expect(upheldEnabled('   ')).toBe(false);
    expect(upheldEnabled(URL_BASE)).toBe(true);
  });
});

describe('verifyAnswer', () => {
  it('maps an AuditReport: flagged excludes supported and uncited claims', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(report)));
    const v = await verifyAnswer(input, { url: URL_BASE });
    expect(v.status).toBe('ok');
    expect(v.supported).toBe(1);
    expect(v.cited).toBe(3);
    expect(v.verifier).toBe('test-verifier@0.5');
    expect(v.flagged).toEqual([
      { claim: 'Pro is $25/month.', verdict: 'unsupported', source: '2', note: 'Passage gives no price.' },
      { claim: 'Hobby is free.', verdict: 'wrong_entity', source: '1', note: 'Hobby not in source.' },
    ]);
    expect(v.ms).toBeGreaterThanOrEqual(0);
  });

  it('returns skipped without a URL and never calls fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const v = await verifyAnswer(input, { url: '' });
    expect(v).toEqual({ status: 'skipped', supported: 0, cited: 0, flagged: [], ms: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns error on HTTP 500 and does not throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const v = await verifyAnswer(input, { url: URL_BASE });
    expect(v.status).toBe('error');
    expect(v.error).toContain('500');
    expect(v.flagged).toEqual([]);
  });

  it('returns error on timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
      ),
    );
    const v = await verifyAnswer(input, { url: URL_BASE, timeoutMs: 30 });
    expect(v.status).toBe('error');
    expect(v.error).toMatch(/30 ms/);
  });

  it('returns error on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));
    const v = await verifyAnswer(input, { url: URL_BASE });
    expect(v.status).toBe('error');
    expect(v.error).toBe('fetch failed');
  });

  it('posts to /audit, sends only sources with passages, joined as text, with ids as strings', async () => {
    const fetchMock = vi.fn(async () => json(report));
    vi.stubGlobal('fetch', fetchMock);
    await verifyAnswer(input, { url: `${URL_BASE}/` });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${URL_BASE}/audit`);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.question).toBe(input.question);
    expect(body.answer).toBe(input.answer);
    expect(body.sources).toEqual([
      {
        id: '1',
        url: 'https://example.com/1',
        title: 'Source 1',
        text: 'Launch plan: $19/month.\n\nAutoscaling included.',
      },
    ]);
  });

  it('truncates the question, answer and source count to upheld limits', async () => {
    const fetchMock = vi.fn(async () => json(report));
    vi.stubGlobal('fetch', fetchMock);
    const many = Array.from({ length: 60 }, (_, i) => source(i + 1, ['p']));
    await verifyAnswer({ question: 'q'.repeat(2500), answer: 'a'.repeat(60_000), sources: many }, { url: URL_BASE });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.question).toHaveLength(2000);
    expect(body.answer).toHaveLength(50_000);
    expect(body.sources).toHaveLength(50);
  });
});

describe('upheldHealth', () => {
  it('is true for a 200 and false for an unreachable server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ status: 'ok' })));
    expect(await upheldHealth(URL_BASE)).toBe(true);

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('ECONNREFUSED');
    }));
    expect(await upheldHealth(URL_BASE)).toBe(false);
    expect(await upheldHealth('')).toBe(false);
  });
});

describe('tablesToClaims', () => {
  it('turns each cited table cell into its own claim and drops uncited cells', async () => {
    const { tablesToClaims } = await import('../src/verify/upheld.js');
    const md = [
      'Nothing changed [1].',
      '',
      '| Item | Then (3 Nov) | Now (10 Nov) | Status |',
      '|---|---|---|---|',
      '| Supabase Pro | $25/month | $25/month [7] | Unchanged |',
      '| Neon Launch | $19/month | $0.106/CU-hour [8][10] | Changed |',
      '| AWS RDS | about $12 | not re-checked | Unverified |',
      '',
      'Done.',
    ].join('\n');
    expect(tablesToClaims(md)).toBe(
      [
        'Nothing changed [1].',
        '',
        'Supabase Pro: $25/month [7]. Neon Launch: $0.106/CU-hour [8][10].',
        '',
        'Done.',
      ].join('\n'),
    );
  });
});

describe('tablesToClaims headers', () => {
  it('keeps a descriptive column header as part of the claim', async () => {
    const { tablesToClaims } = await import('../src/verify/upheld.js');
    const md = '| Tool | Starting price | Status |\n|---|---|---|\n| Zoho CRM | $14/user/month [3] | Unchanged |';
    expect(tablesToClaims(md)).toBe('Zoho CRM — Starting price: $14/user/month [3].');
  });
});
