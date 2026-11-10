// The grounding check: a model-free, always-on check that every figure in a cited claim
// appears in the passages of the source it cites. It runs in milliseconds with no service
// behind it, so it runs on every answer, the hosted demo included.
//
// It is narrower than verification, and named so. It catches a price, a limit or a percentage
// that isn't in the cited text (made up, misremembered, or carried over from the past). It
// can't tell that a claim misreads a figure that *is* there: that needs a model, which is what
// upheld does when UPHELD_URL is set.
import { tablesToClaims } from './upheld.js';
import type { Source, Verification } from '../types.js';

export const GROUNDING = 'grounding';

/** Per-claim verdicts. Only cited claims that carry a figure are counted. */
export type GroundingVerdict = 'grounded' | 'number not in source' | 'no passage';

export interface Figure {
  /** As written in the answer, e.g. "$0.106" or "20%". */
  text: string;
  /** The value, so "$1,500" and "$1500.00" compare equal; a version ("26.13.1") as written. */
  key: string;
  /** A currency symbol or code, "%", or "" for a bare number. */
  unit: string;
}

export interface GroundedClaim {
  text: string;
  cites: number[];
  verdict: GroundingVerdict;
  missing: Figure[];
}

const CURRENCY: Record<string, string> = { $: '$', '€': '€', '£': '£', '₹': '₹', '¥': '¥', usd: '$', eur: '€', gbp: '£', inr: '₹' };
const UNIT = '%|percent|[kmgtp]i?b|ms|s|k|users?|seats?|tokens?|requests?|req|rpm|rps|hours?|hrs?|h|mins?|minutes?|seconds?|days?|months?|projects?|rows?|cu';
const MONTH =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

/**
 * A number with an optional currency before it, an optional multiplier (1.5k, $2M, 3 billion)
 * and an optional % or currency code after it. Digits glued to letters on the left (db.t4g, Q3,
 * v2) are part of a name, not a figure.
 */
const FIGURE =
  /(?<![\p{L}\p{N}_.])(US\$|[$€£₹¥]|(?:USD|EUR|GBP|INR)\s?)?\s?(\d{1,3}(?:,\d{3})+|\d+)((?:\.\d+)+)?(?:\s?(k|K|M|B|bn|thousand|million|billion)\b)?(\s?(?:%|percent\b|(?:USD|EUR|GBP|INR)\b))?/gu;
const MULTIPLIER: Record<string, number> = { k: 1e3, K: 1e3, thousand: 1e3, M: 1e6, million: 1e6, B: 1e9, bn: 1e9, billion: 1e9 };

/** Dates name when, and the date in an answer is often today's, not one the page states. */
const DATES = [
  new RegExp(`\\b\\d{1,2}\\s*[–-]\\s*\\d{1,2}\\s+${MONTH}\\b\\.?(?:,?\\s+\\d{4})?`, 'gi'),
  new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}\\s*[–-]\\s*\\d{1,2}\\b(?:,?\\s+\\d{4})?`, 'gi'),
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\b\\.?(?:,?\\s+\\d{4})?`, 'gi'),
  new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?:,?\\s+\\d{4})?`, 'gi'),
  new RegExp(`\\b${MONTH}\\.?\\s+\\d{4}\\b`, 'gi'),
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
  /\b\d{1,2}\.\d{1,2}\.\d{4}\b/g, // dotted dates need a four-digit year: 24.11.12 is a version
  // A bare year, but not "$2000" or "2048 MB": a currency or a unit makes it a figure.
  new RegExp(`(?<![$€£₹¥]\\s?)\\b(?:19|20)\\d{2}\\b(?![.,]\\d|\\s?(?:${UNIT})\\b)`, 'gi'),
  /\b\d{1,2}:\d{2}\b/g,
];

/**
 * A figure the sentence says is *not* the value ("$10, not $6", "down from $0.14", "instead of
 * $19") is a correction of the past, usually from memory, and isn't claimed to be on the page.
 */
const CONTRAST = /(?:\bnot|n't|\bno longer|\binstead of|\brather than|\bdown from|\bup from|\bpreviously|\bformerly|\bused to be)(?:\s+(?:a|an|the|flat|just|only|about|around|roughly))*\s*~?\s*$/i;

const MARKER = /\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\](?!\()/g;
const MARKER_RUN = /(?:\s*\[\d{1,3}(?:\s*,\s*\d{1,3})*\](?!\())+/g;

function blank(text: string, re: RegExp): string {
  return text.replace(re, (m) => ' '.repeat(m.length));
}

/** The figures in a piece of text, dates and contrasted values left out. */
export function figures(text: string, opts: { skipContrast?: boolean } = {}): Figure[] {
  let t = text;
  for (const re of DATES) t = blank(t, re);
  const out: Figure[] = [];
  for (const m of t.matchAll(FIGURE)) {
    const [, before, whole, frac, scale, after] = m;
    if (opts.skipContrast && CONTRAST.test(t.slice(Math.max(0, m.index - 40), m.index))) continue;
    const unit = unitOf(before, after);
    const digits = `${whole!.replace(/,/g, '')}${frac ?? ''}`;
    const version = (frac ?? '').split('.').length > 2;
    const key = version ? digits : String(Math.round(Number(digits) * (MULTIPLIER[scale ?? ''] ?? 1) * 1e6) / 1e6);
    out.push({ text: m[0].trim(), key, unit });
  }
  return out;
}

function unitOf(before?: string, after?: string): string {
  const b = before?.trim().toLowerCase().replace(/^us(?=\$)/, '');
  if (b) return CURRENCY[b] ?? b;
  const a = after?.trim().toLowerCase();
  if (!a) return '';
  if (a === '%' || a === 'percent') return '%';
  return CURRENCY[a] ?? a;
}

/** Strips the markdown that would get in the way of splitting sentences. */
function plain(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1')
    .replace(/(\*\*|__|\*)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '');
}

/** Sentences that cite at least one source. A marker left after the full stop joins the sentence before it. */
export function citedSentences(markdown: string): string[] {
  const pieces = plain(tablesToClaims(markdown))
    .split(/\n+|(?<=[.!?])\s+(?=[\p{Lu}\p{N}"“'‘(\[$€£₹])/u)
    .map((s) => s.trim())
    .filter(Boolean);
  const merged: string[] = [];
  for (const piece of pieces) {
    const lead = piece.match(/^(?:\[\d{1,3}(?:\s*,\s*\d{1,3})*\]\s*)+/)?.[0];
    if (lead && merged.length) {
      merged[merged.length - 1] += ` ${lead.trim()}`;
      const rest = piece.slice(lead.length).trim();
      if (rest) merged.push(rest);
    } else merged.push(piece);
  }
  return merged.filter((s) => /\[\d{1,3}(?:\s*,\s*\d{1,3})*\](?!\()/.test(s));
}

/**
 * Each stretch of a sentence goes with the markers that close it: in "Neon is $0.106 per CU-hour
 * [5], with a $5 minimum [6]", $0.106 is looked for in [5] and $5 in [6]. Text after the last
 * marker goes with that marker.
 */
function segments(sentence: string): Array<{ text: string; cites: number[] }> {
  const out: Array<{ text: string; cites: number[] }> = [];
  let start = 0;
  for (const run of sentence.matchAll(MARKER_RUN)) {
    const cites = [...run[0].matchAll(MARKER)].flatMap((m) => m[1]!.split(',').map((n) => Number(n.trim())));
    out.push({ text: sentence.slice(start, run.index), cites });
    start = run.index + run[0].length;
  }
  const tail = sentence.slice(start);
  if (out.length && tail.trim()) out[out.length - 1]!.text += tail;
  return out;
}

/** A bare 0 or 1 is a range's end ("1–100 users") or a count ("1 project"), not a figure to look up. */
function trivial(fig: Figure): boolean {
  return fig.unit === '' && (fig.key === '0' || fig.key === '1');
}

/** True when the figure, with its unit, appears in the text: "$5" matches "$5.00/mo", not "5 GB". */
function appears(fig: Figure, haystack: Figure[]): boolean {
  return haystack.some((h) => {
    if (h.key !== fig.key) return false;
    if (fig.unit === '') return true;
    return h.unit === fig.unit;
  });
}

export interface GroundingInput {
  answer: string;
  sources: Source[];
  /** The user's question: a bare count it gives ("a 20-person team") is their premise, not the source's. */
  question?: string;
}

export function checkGrounding(input: GroundingInput): { claims: GroundedClaim[]; ms: number } {
  const started = performance.now();
  const premise = figures(input.question ?? '').filter((f) => f.unit === '');
  const bySource = new Map<number, Figure[] | null>();
  for (const s of input.sources) {
    const text = s.passages.join('\n');
    bySource.set(s.n, text.trim() ? figures(`${s.title}\n${text}`) : null);
  }

  const claims: GroundedClaim[] = [];
  for (const sentence of citedSentences(input.answer)) {
    const parts = segments(sentence)
      .map((seg) => ({ ...seg, figures: figures(seg.text, { skipContrast: true }).filter((f) => !trivial(f) && !appears(f, premise)) }))
      .filter((seg) => seg.figures.length);
    if (!parts.length) continue;

    const cites = [...new Set(parts.flatMap((p) => p.cites))];
    const missing: Figure[] = [];
    let checkable = false;
    for (const part of parts) {
      const evidence = part.cites.map((n) => bySource.get(n)).filter((f): f is Figure[] => Array.isArray(f));
      if (!evidence.length) continue;
      checkable = true;
      const pool = evidence.flat();
      for (const fig of part.figures) if (!appears(fig, pool)) missing.push(fig);
    }
    const text = sentence.replace(MARKER_RUN, (m) => ` ${m.trim()}`).replace(/\s+/g, ' ').trim();
    claims.push({
      text,
      cites,
      verdict: !checkable ? 'no passage' : missing.length ? 'number not in source' : 'grounded',
      missing,
    });
  }
  return { claims, ms: Math.round(performance.now() - started) };
}

/** The grounding check in the shape the store, the UI and the evals already read. */
export function groundAnswer(input: GroundingInput): Verification {
  const { claims, ms } = checkGrounding(input);
  return {
    status: 'ok',
    supported: claims.filter((c) => c.verdict === 'grounded').length,
    cited: claims.length,
    flagged: claims
      .filter((c) => c.verdict !== 'grounded')
      .map((c) => ({
        claim: c.text,
        verdict: c.verdict,
        source: c.cites.length ? c.cites.map(String).join(', ') : undefined,
        note: c.missing.length ? `Not in the cited text: ${[...new Set(c.missing.map((f) => f.text))].join(', ')}` : undefined,
      })),
    verifier: GROUNDING,
    ms,
  };
}
