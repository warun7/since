// The grounding check: a model-free, always-on check that every figure in a cited claim
// appears in the passages of the source it cites. It runs in milliseconds with no service
// behind it, so it runs on every answer, the hosted demo included.
//
// It is narrower than verification, and named so. It catches a price, a limit or a percentage
// that isn't in the cited text (made up, misremembered, or carried over from the past), and a
// total that doesn't add up: a figure worked out from the cited ones (a seat price times the
// user's team size, a monthly price times 12) is checked by redoing the sum. It can't tell
// that a claim misreads a figure that *is* there: that needs a model, which is what upheld
// does when UPHELD_URL is set.
import { tablesToClaims } from './upheld.js';
import type { Source, Verification } from '../types.js';

export const GROUNDING = 'grounding';

/**
 * Per-claim verdicts. Only cited claims that carry a figure are counted. "in another source":
 * every missing figure is on a page the model was shown, just not the one it cited.
 */
export type GroundingVerdict = 'grounded' | 'number not in source' | 'in another source' | 'no passage';

export interface Figure {
  /** As written in the answer, e.g. "$0.106" or "20%". */
  text: string;
  /** The value, so "$1,500" and "$1500.00" compare equal; a version ("26.13.1") as written. */
  key: string;
  /** A currency symbol or code, "%", or "" for a bare number. */
  unit: string;
}

export interface WorkedFigure {
  /** As written in the answer. */
  text: string;
  /** The sum that gives it, from the cited figures: "= 15 × $10", "≈ 15 × $8.15 × 12", "≈ $8.15". */
  how: string;
}

export interface GroundedClaim {
  text: string;
  cites: number[];
  verdict: GroundingVerdict;
  /** Figures neither in the cited passages nor worked out from them. */
  missing: Figure[];
  /** Of the missing, the ones on another page the model was shown: the cites of the figure's part, and the pages it is on. */
  elsewhere: Array<{ figure: Figure; cites: number[]; sources: number[] }>;
  /** Figures not on the page but worked out from it. */
  worked: WorkedFigure[];
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
const MONEY = new Set(Object.values(CURRENCY));
const RANGE = /^\s*(?:[–—-]|to)\s*$/;

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
  let prev: { end: number; unit: string } | null = null;
  for (const m of t.matchAll(FIGURE)) {
    const [, before, whole, frac, scale, after] = m;
    const end = m.index + m[0].length;
    let unit = unitOf(before, after);
    // The far end of a range takes the currency of the near one: "$2,900–3,500" is two prices.
    if (!unit && prev && MONEY.has(prev.unit) && RANGE.test(t.slice(prev.end, m.index))) unit = prev.unit;
    prev = { end, unit };
    if (opts.skipContrast && CONTRAST.test(t.slice(Math.max(0, m.index - 40), m.index))) continue;
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

/** "about $8", "~$150": the answer says the figure is rounded. */
const APPROX = /(?:~|≈|\b(?:about|around|roughly|approximately|approx\.?|nearly|almost|circa))\s*$/i;
/** A team size: "15 users", "a 20-person team", "for 15 seats", "a team of 12". */
const HEADCOUNT =
  /\b(\d{1,3}(?:,\d{3})+|\d+)(?:\s+|-)(?:users?|seats?|people|persons?|members?|employees?|engineers?|developers?|devs?|agents?|licen[cs]es?)\b|\bteam of (\d+)\b/gi;
/** Price pairs tried as differences ("$90 more" = 15 × ($16 − $10)); more prices than this aren't paired. */
const MAX_PRICES = 40;
/** What the figure is per, from the words after it ("$1,800 a year", "$150/mo", "$10 per user"). */
const PER_YEAR = /^\s*(?:\/\s*(?:yr|year|annum)\b|(?:a|per|each|every)\s+year\b|annually\b|yearly\b|per\s+annum\b)/i;
const PER_MONTH = /^\s*(?:\/\s*(?:mo|month)\b|(?:a|per|each|every)\s+month\b|monthly\b)/i;
const PER_SEAT = /^\s*(?:\/\s*|(?:a|per|each)\s+)(?:users?|seats?|members?|agents?|persons?|heads?|editors?|licen[cs]es?)\b/i;
/** The rest of a range after its near end: "–$1,750/year" says what "$1,470" is per. */
const RANGE_REST = /^\s*(?:[–—-]|to)\s*(?:US\$|[$€£₹¥])?\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|K|M|B|bn))?/;

interface FigureContext {
  /** The answer says it's rounded: "about $8". */
  approx: boolean;
  year: boolean;
  month: boolean;
  /** A per-seat price is never a team total. */
  seat: boolean;
}

function contextOf(text: string, fig: Figure): FigureContext | null {
  const at = text.indexOf(fig.text);
  if (at < 0) return null;
  const after = text.slice(at + fig.text.length).replace(RANGE_REST, '');
  return {
    approx: APPROX.test(text.slice(Math.max(0, at - 12), at)),
    year: PER_YEAR.test(after),
    month: PER_MONTH.test(after),
    seat: PER_SEAT.test(after),
  };
}

/**
 * How far a worked-out value may be from the figure: the figure's own rounding ("$1,800" is to
 * the nearest 100, "$122" to the dollar, "$145.50" to the cent), and never more than 1%, or 3%
 * when the answer says "about".
 */
function tolerance(fig: Figure, approx: boolean): number {
  const value = Number(fig.key);
  const m = fig.text.match(/(\d[\d,]*)((?:\.\d+)?)\s?(k|K|M|B|bn|thousand|million|billion)?/);
  if (!m) return 0;
  const [, whole = '', frac = '', scale] = m;
  const place = frac ? -(frac.length - 1) : whole.replace(/,/g, '').match(/0*$/)![0].length;
  const half = 0.5 * 10 ** place * (MULTIPLIER[scale ?? ''] ?? 1);
  // "~$7.90" for $7.91: a figure the answer calls approximate is rounded, whatever digits it shows.
  return approx ? Math.min(Math.max(half, value * 0.01), value * 0.03) : Math.min(half, value * 0.01);
}

/**
 * The sum that gives a price from the cited prices: a price times the team size (or the gap
 * between two prices times it, "an extra $90/mo"), and times 12 only for a figure the answer
 * gives per year (÷ 12 per month). Simplest first. A figure merely rounded from the page only
 * counts when the answer says it is ("about $8" for $8.15). Each of these limits keeps a wrong
 * figure from passing as some other sum of the numbers on the page.
 */
function workOut(fig: Figure, ctx: FigureContext, pool: Figure[], counts: number[]): string | null {
  const value = Number(fig.key);
  if (!MONEY.has(fig.unit) || !(value > 0)) return null;
  const tol = tolerance(fig, ctx.approx);
  const prices = [...new Map(pool.filter((f) => f.unit === fig.unit && Number(f.key) > 0).map((f) => [Number(f.key), f.text])).entries()]
    .slice(0, MAX_PRICES)
    .map(([v, text]) => ({ v, label: text.replace(/(?<=[$€£₹¥])\s+/u, '') }));
  const gaps = prices.flatMap((a) => prices.filter((b) => b.v < a.v).map((b) => ({ v: a.v - b.v, label: `(${a.label} − ${b.label})` })));
  const heads = ctx.seat ? [] : [...new Set(counts)];
  const yearly: [number, string] = [12, ' × 12'];
  const monthly: [number, string] = [1 / 12, ' ÷ 12'];
  // A yearly figure is tried as a monthly price times 12 before anything else.
  const steps: Array<{ bases: typeof prices; heads: number[]; period: [number, string] }> = [
    ...(ctx.year ? [{ bases: prices, heads, period: yearly }, { bases: prices, heads: [1], period: yearly }] : []),
    { bases: prices, heads, period: [1, ''] },
    ...(ctx.month ? [{ bases: prices, heads, period: monthly }, { bases: prices, heads: [1], period: monthly }] : []),
    { bases: gaps, heads, period: [1, ''] },
    ...(ctx.year ? [{ bases: gaps, heads, period: yearly }] : []),
  ];
  const close = (v: number) => Math.abs(v - value) <= tol + 1e-9;
  const sign = (v: number) => (Math.abs(v - value) < 0.005 ? '=' : '≈');
  if (ctx.approx) {
    const near = prices.find((p) => close(p.v));
    if (near) return `≈ ${near.label}`;
  }
  for (const { bases, heads: hs, period } of steps) {
    for (const base of bases) {
      for (const h of hs) {
        const v = base.v * h * period[0];
        if (close(v)) return `${sign(v)} ${h > 1 ? `${h} × ` : ''}${base.label}${period[1]}`;
      }
    }
  }
  return null;
}

/** Team sizes a total may be worked out with: headcounts in the question and in the claim. */
function headcounts(question: string, claim: string): number[] {
  return [...`${question}\n${claim}`.matchAll(HEADCOUNT)]
    .map((m) => Number((m[1] ?? m[2])!.replace(/,/g, '')))
    .filter((n) => Number.isInteger(n) && n >= 2 && n <= 100_000);
}

export interface GroundingInput {
  answer: string;
  sources: Source[];
  /** The user's question: a bare count it gives ("a 20-person team") is their premise, not the source's. */
  question?: string;
  /** Every source the model was shown: a figure missing from the cited ones is looked for here. */
  shown?: Source[];
}

export function checkGrounding(input: GroundingInput): { claims: GroundedClaim[]; ms: number } {
  const started = performance.now();
  const premise = figures(input.question ?? '').filter((f) => f.unit === '');
  const bySource = new Map<number, Figure[] | null>();
  for (const s of [...(input.shown ?? []), ...input.sources]) {
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
    const elsewhere: GroundedClaim['elsewhere'] = [];
    const worked: WorkedFigure[] = [];
    let checkable = false;
    for (const part of parts) {
      const evidence = part.cites.map((n) => bySource.get(n)).filter((f): f is Figure[] => Array.isArray(f));
      if (!evidence.length) continue;
      checkable = true;
      const pool = evidence.flat();
      const counts = headcounts(input.question ?? '', sentence);
      for (const fig of part.figures) {
        if (appears(fig, pool)) continue;
        const ctx = contextOf(part.text, fig);
        const how = ctx && workOut(fig, ctx, pool, counts);
        if (how) {
          worked.push({ text: fig.text, how });
          continue;
        }
        missing.push(fig);
        const found = [...bySource]
          .filter(([n, figs]) => !part.cites.includes(n) && figs && appears(fig, figs))
          .map(([n]) => n)
          .sort((a, b) => a - b);
        if (found.length) elsewhere.push({ figure: fig, cites: part.cites, sources: found });
      }
    }
    const text = sentence.replace(MARKER_RUN, (m) => ` ${m.trim()}`).replace(/\s+/g, ' ').trim();
    const verdict: GroundingVerdict = !checkable
      ? 'no passage'
      : !missing.length
        ? 'grounded'
        : elsewhere.length === missing.length
          ? 'in another source'
          : 'number not in source';
    claims.push({ text, cites, verdict, missing, elsewhere, worked });
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
        note: c.missing.length ? `Not in the cited text: ${missingList(c)}` : undefined,
      })),
    worked: claims.flatMap((c) => c.worked.map((w) => ({ figure: w.text, how: w.how, source: c.cites.join(', ') || undefined }))),
    verifier: GROUNDING,
    ms,
  };
}

/** "$7, $9.70 (in [17])": each missing figure once, with the page it is on when it is on one. */
function missingList(claim: GroundedClaim): string {
  const seen = new Map<string, string>();
  for (const f of claim.missing) {
    if (seen.has(f.text)) continue;
    const where = claim.elsewhere.find((e) => e.figure === f)?.sources;
    seen.set(f.text, where ? `${f.text} (in ${where.map((n) => `[${n}]`).join('')})` : f.text);
  }
  return [...seen.values()].join(', ');
}

export interface AddedCitation {
  figure: string;
  source: number;
}

/** Words too common in pricing pages to tie a claim to one: "Jira" ties it, "pricing" doesn't. */
const COMMON = new Set(
  ('the and for with per from that this are was not but you your our its all any has have will can each one two new old ' +
    'price prices pricing plan plans cost costs user users seat seats month monthly year yearly annual annually free tier ' +
    'team teams paid billing billed list official page site guide review vs compare comparison best www com app org io')
    .split(' '),
);

function words(text: string): Set<string> {
  return new Set([...text.toLowerCase().matchAll(/\p{L}[\p{L}\p{N}]{2,}/gu)].map((m) => m[0]).filter((w) => !COMMON.has(w)));
}

/**
 * Adds the citation the model left out. A price or percentage that isn't on the page its claim
 * cites, but is on another page the model was shown, gets that page's number after the claim's
 * markers: "… $6.99/user [1][3]" becomes "… [1][3][8]". A figure like "$16" is on many pages, so
 * the page must also share a name or another of the claim's figures with it ("Jira", "$19.60"),
 * and the most related page wins, then the most authoritative. Left alone: bare numbers ("2" is
 * on too many pages to say which was meant), $0, and figures in quotation marks, which quote
 * something said rather than state a price. It runs before the answer is saved, so the reader,
 * the memory and the check all see the same text, and the verification lists what was added.
 */
export function repairCitations(input: GroundingInput): { answer: string; added: AddedCitation[] } {
  const shown = new Map((input.shown ?? []).map((s) => [s.n, s]));
  const pageFigures = new Map([...shown].map(([n, s]) => [n, figures(`${s.title}\n${s.passages.join('\n')}`)]));
  let answer = input.answer;
  const added: AddedCitation[] = [];
  for (const claim of checkGrounding(input).claims) {
    const claimWords = words(claim.text.replace(MARKER_RUN, ' '));
    const claimFigures = figures(claim.text.replace(MARKER_RUN, ' '));
    for (const { figure, cites, sources } of claim.elsewhere) {
      if (figure.unit === '' || Number(figure.key) === 0) continue;
      const related = (n: number) => {
        const page = shown.get(n);
        if (!page) return 0;
        const named = [...words(`${page.title} ${page.site}`)].filter((w) => claimWords.has(w)).length;
        const others = claimFigures.filter((f) => f.key !== figure.key && appears(f, pageFigures.get(n) ?? [])).length;
        return named + others;
      };
      const ranked = sources
        .map((n) => ({ n, score: related(n), authority: shown.get(n)?.authority ?? -1 }))
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score || b.authority - a.authority || a.n - b.n);
      const best = ranked[0]?.n;
      if (best === undefined) continue;
      const next = addMarker(answer, figure.text, cites, best);
      if (next === answer) continue;
      answer = next;
      added.push({ figure: figure.text, source: best });
    }
  }
  return { answer, added };
}

/** The end of a sentence or a table cell: a full stop before a space, a line break, a cell edge. */
const BOUNDARY = /[.!?](?=\s|$)|\n|\|/g;

function citesOf(run: string): number[] {
  return [...run.matchAll(MARKER)].flatMap((m) => m[1]!.split(',').map((x) => Number(x.trim())));
}

const setKey = (ns: number[]) => [...new Set(ns)].sort((a, b) => a - b).join(',');

/**
 * Adds [n] where the figure's part of the sentence is cited, if that part cites exactly `cites`:
 * after the first markers following the figure in its sentence or table cell, or, when the
 * figure comes after the sentence's last markers, at the end of the sentence.
 */
function addMarker(answer: string, figure: string, cites: number[], n: number): string {
  const want = setKey(cites);
  for (let at = answer.indexOf(figure); at >= 0; at = answer.indexOf(figure, at + 1)) {
    const end = at + figure.length;
    // "$16" is not the start of "$160" or "$16.50".
    if (/^(?:\d|[.,]\d)/.test(answer.slice(end)) || /[\p{L}\p{N}]$/u.test(answer.slice(0, at))) continue;
    const boundary = new RegExp(BOUNDARY.source, 'g');
    boundary.lastIndex = end;
    const limit = boundary.exec(answer)?.index ?? answer.length;
    // A figure in quotation marks quotes something said ('the "$19/month plan" I gave you').
    const lead = answer.slice(0, at).split(new RegExp(BOUNDARY.source)).at(-1) ?? '';
    if ((lead.match(/"/g) ?? []).length % 2 === 1 || lead.lastIndexOf('“') > lead.lastIndexOf('”')) continue;

    const runs = new RegExp(MARKER_RUN.source, 'g');
    runs.lastIndex = end;
    const next = runs.exec(answer);
    // Markers left just after the full stop still close the sentence.
    const closes = next && (next.index < limit || /^[.!?]\s*$/.test(answer.slice(limit, next.index)));
    if (next && closes) {
      const has = citesOf(next[0]);
      if (has.includes(n) || setKey(has) !== want) continue;
      const close = next.index + next[0].length;
      return `${answer.slice(0, close)}[${n}]${answer.slice(close)}`;
    }

    // No markers after it: the figure trails the sentence's last markers, which must be in the same sentence.
    const before = [...answer.slice(0, at).matchAll(new RegExp(MARKER_RUN.source, 'g'))].at(-1);
    if (!before) continue;
    const between = answer.slice(before.index + before[0].length, at);
    if (new RegExp(BOUNDARY.source).test(between) || setKey(citesOf(before[0])) !== want) continue;
    let pos = limit;
    while (pos > end && /\s/.test(answer[pos - 1]!)) pos--;
    return `${answer.slice(0, pos)} [${n}]${answer.slice(pos)}`;
  }
  return answer;
}
