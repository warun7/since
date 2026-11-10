// Optional citation checking with upheld (`upheld serve`, a local Python service).
// upheld checks each cited claim against the passages the model was shown, so the
// sources we send carry their passages as text and upheld never refetches a page.
// Nothing here throws: a missing, slow or broken upheld yields a Verification with a status.
import { config } from '../config.js';
import type { Source, Verification } from '../types.js';

/** The fields of upheld's AuditReport (POST /audit) that this client reads. */
interface AuditReport {
  verifier: string;
  summary: { cited_claims: number; supported_claims: number };
  claims: Array<{
    text: string;
    verdict: string;
    cited?: string[];
    checks?: Array<{ source_id: string; verdict: string; note?: string | null }>;
    note?: string | null;
  }>;
}

const HEALTH_TIMEOUT_MS = 1_500;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_QUESTION_CHARS = 2_000;
const MAX_ANSWER_CHARS = 50_000;
const MAX_SOURCES = 50;

type Flag = Verification['flagged'][number];

function normalise(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function upheldEnabled(url: string = config.upheldUrl): boolean {
  return normalise(url) !== '';
}

/** True when `GET {url}/health` answers 2xx within 1.5 s. */
export async function upheldHealth(url: string = config.upheldUrl): Promise<boolean> {
  const base = normalise(url);
  if (!base) return false;
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    await res.text().catch(() => undefined);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Checks an answer's citations against the passages it was grounded on.
 * Sources without passages are left out: upheld has nothing to check them against.
 */
/**
 * upheld checks sentences, and a markdown table row is not one: "| Supabase Pro | $25 | $25 [7] |
 * Unchanged |" mixes a value recalled from memory, a value from the source and a verdict, so the
 * row fails as a whole even when the cited cell is right. Each cited cell becomes its own claim,
 * named by the row's first cell and the column header: "Supabase Pro — Now: $25 [7]." Uncited
 * cells (the "Then" column comes from memory, not from a source) are not claims to check.
 */
const TIME_COLUMN = /^(now|then|current|currently|today|latest|before|after|was|is)\b/i;

export function tablesToClaims(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const isRow = (line: string | undefined) => line !== undefined && /^\s*\|.*\|\s*$/.test(line);
  const isSeparator = (line: string | undefined) => line !== undefined && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);

  for (let i = 0; i < lines.length; i++) {
    if (!(isRow(lines[i]) && isSeparator(lines[i + 1]))) {
      out.push(lines[i]);
      continue;
    }
    const header = cells(lines[i]);
    i += 2;
    const claims: string[] = [];
    for (; i < lines.length && isRow(lines[i]); i++) {
      const row = cells(lines[i]);
      for (let c = 1; c < row.length; c++) {
        if (!/\[\d{1,3}(?:\s*,\s*\d{1,3})*\]/.test(row[c])) continue;
        // A time column ("Now (10 Nov 2026)") names when, not what: its date isn't on the page.
        const label = (header[c] ?? '').replace(/\(.*?\)/g, '').trim();
        const named = label && !TIME_COLUMN.test(label) ? `${row[0]} — ${label}` : row[0];
        claims.push(`${named}: ${row[c].replace(/[.\s]+$/, '')}.`);
      }
    }
    i--;
    out.push(claims.join(' '));
  }
  return out.join('\n');
}

export async function verifyAnswer(
  input: { question: string; answer: string; sources: Source[] },
  opts: { url?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Verification> {
  const base = normalise(opts.url ?? config.upheldUrl);
  if (!base) return { status: 'skipped', supported: 0, cited: 0, flagged: [], ms: 0 };

  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const fail = (error: string): Verification => ({ status: 'error', supported: 0, cited: 0, flagged: [], ms: elapsed(), error });

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', onCallerAbort, { once: true });
  }

  try {
    const body = {
      question: input.question.slice(0, MAX_QUESTION_CHARS),
      answer: tablesToClaims(input.answer).slice(0, MAX_ANSWER_CHARS),
      sources: input.sources
        .filter((s) => s.passages.length > 0)
        .slice(0, MAX_SOURCES)
        .map((s) => ({ id: String(s.n), url: s.url, title: s.title, text: s.passages.join('\n\n') })),
    };
    const res = await fetch(`${base}/audit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      return fail(`upheld returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    const report = (await res.json()) as AuditReport;
    if (!report || typeof report !== 'object' || !report.summary) return fail('unexpected response from upheld');
    return toVerification(report, elapsed());
  } catch (err) {
    if (timedOut) return fail(`upheld did not answer within ${timeoutMs} ms`);
    if (opts.signal?.aborted) return fail('citation check was aborted');
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onCallerAbort);
  }
}

function toVerification(report: AuditReport, ms: number): Verification {
  const claims = Array.isArray(report.claims) ? report.claims : [];
  const flagged: Flag[] = claims
    .filter((c) => c.verdict !== 'supported' && c.verdict !== 'uncited')
    .map((c) => {
      const first = c.checks?.[0];
      return {
        claim: c.text,
        verdict: c.verdict,
        source: first?.source_id,
        note: c.note ?? first?.note ?? undefined,
      };
    });
  return {
    status: 'ok',
    supported: report.summary.supported_claims ?? 0,
    cited: report.summary.cited_claims ?? 0,
    flagged,
    verifier: report.verifier,
    ms,
  };
}
