import { config } from '../config.js';
import type { RawResult, SearchProvider, SearchQuery } from '../types.js';
import { clipWords } from './passages.js';

// The provider rejects longer operator queries and questions with a 400.
const MAX_QUERY_CHARS = 128;

export interface DeepSeekOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchTimeoutMs?: number;
}

/** One result as the search endpoint returns it (snake_case, nullable). */
interface ApiResult {
  url?: string | null;
  title?: string | null;
  snippet?: string | null;
  summary?: string | null;
  content?: string | null;
  site_name?: string | null;
  date?: string | null;
  rerank_score?: number | null;
  authority?: number | null;
}

/**
 * Renders a SearchQuery in the provider's operator syntax. An operator the model also wrote
 * into the free text is removed, so the same site or date never appears twice.
 */
export function buildQuery(q: SearchQuery, lang?: string): string {
  const site = q.site?.trim() ?? '';
  const after = q.after?.trim() ?? '';
  let text = q.q;
  if (site) text = text.replace(/(^|\s)site:\S+/gi, '$1');
  if (after) text = text.replace(/(^|\s)after:\S+/gi, '$1');
  // Operators are the part that must survive truncation, so the free text gives up its room first.
  if (lang) text = text.replace(/(^|\s)lang:\S+/gi, '$1');
  const suffix = `${site ? ` site:${site}` : ''}${after ? ` after:${after}` : ''}${lang ? ` lang:${lang}` : ''}`;
  const free = clipWords(text.replace(/\s+/g, ' ').trim(), MAX_QUERY_CHARS - suffix.length);
  return `${free}${suffix}`.trim();
}

export class DeepSeekSearch implements SearchProvider {
  readonly name = 'deepseek';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchTimeoutMs: number;

  constructor(opts: DeepSeekOptions = {}) {
    this.apiKey = opts.apiKey ?? config.deepseekApiKey;
    this.baseUrl = (opts.baseUrl ?? config.deepseekBaseUrl).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? 6000;
  }

  async search(
    query: SearchQuery,
    opts: { question?: string; count?: number; lang?: string; signal?: AbortSignal } = {},
  ): Promise<RawResult[]> {
    const question = opts.question?.trim();
    // need_content is always on: the passage selector works on page text, not the short snippet.
    const json = (await this.post(
      '/v1/tools/search',
      {
        query: buildQuery(query, opts.lang),
        count: Math.min(50, Math.max(1, opts.count ?? 10)),
        need_content: true,
        ...(question ? { ori_question: question.slice(0, MAX_QUERY_CHARS) } : {}),
      },
      opts.signal,
      this.timeoutMs,
    )) as { results?: ApiResult[] };

    return (json.results ?? [])
      .filter((r): r is ApiResult & { url: string } => typeof r.url === 'string' && r.url !== '')
      .map((r, rank) => ({
        url: r.url,
        title: r.title ?? '',
        snippet: r.snippet ?? '',
        summary: r.summary ?? '',
        content: r.content ?? '',
        siteName: r.site_name ?? undefined,
        date: isoDate(r.date),
        rerankScore: r.rerank_score ?? undefined,
        authority: r.authority ?? undefined,
        query,
        rank,
      }));
  }

  /** Returns null for any failure. A blocked or unreadable page must not fail the search. */
  async fetchPage(url: string, signal?: AbortSignal): Promise<{ title: string; content: string } | null> {
    try {
      const json = (await this.post('/v1/tools/fetch', { url }, signal, this.fetchTimeoutMs)) as {
        title?: string;
        content?: string;
      };
      return { title: json.title ?? '', content: json.content ?? '' };
    } catch {
      return null;
    }
  }

  private async post(path: string, body: unknown, signal: AbortSignal | undefined, timeoutMs: number): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      // A fresh timeout per attempt, so a retry gets the full budget.
      const timeout = AbortSignal.timeout(timeoutMs);
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (res.ok) return res.json();
      // One retry for overload and rate limits only. Other 4xx are caller errors that retrying cannot fix.
      const transient = res.status === 408 || res.status === 429 || res.status >= 500;
      if (transient && attempt === 1 && !signal?.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        continue;
      }
      throw new Error(`DeepSeek search ${res.status}: ${await errorMessage(res)}`);
    }
  }
}

async function errorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const message = (JSON.parse(text) as { error?: { message?: string } }).error?.message;
    if (message) return message;
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return text.slice(0, 200) || res.statusText || 'request failed';
}

function isoDate(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
