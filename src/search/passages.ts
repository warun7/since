import type { SearchQuery } from '../types.js';

// Function words carry no signal for BM25. Pricing words are deliberately absent: they drive
// the pricing boost below, so they must survive tokenization.
const STOPWORDS = new Set(
  `a about above after again against all am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself`.split(
    ' ',
  ),
);

const PRICING = new Set(['price', 'pricing', 'cost', 'plan', 'plans', 'per', 'seat', 'month', 'tier', 'free']);
const CURRENCY_OR_NUMBER = /[$€£¥]|\d/;
// Keeps "$19", "19.99", "v22" and "2026" whole; everything else splits on non-letters.
const TOKEN = /\$?\d+(?:\.\d+)*|\p{L}[\p{L}\p{N}]*/gu;
const OPERATOR = /\b(?:site|after|before|lang):\S+/gi;

const WINDOW_WORDS = 110;
const WINDOW_STRIDE = 80;
// Below this, the page is short enough that the summary is a better reading than windows.
const SHORT_DOC_CHARS = 400;
const K1 = 1.2;
const B = 0.75;

/**
 * Scripts the letter-only regex cannot tokenise: CJK writes without spaces, so a whole phrase
 * became one token ("的价格是多少"), and Indic, Arabic and Hebrew text carries combining marks
 * the regex drops (Hindi "कीमत" came out as "मत"). Those go through Intl.Segmenter; everything
 * else keeps the regex, so English and numeric tokens are unchanged and old runs stay comparable.
 */
const NEEDS_SEGMENTER =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Arabic}\p{Script=Hebrew}]/u;
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'word' });
const CURRENCY_SYMBOL = /^[$€£¥]$/;
const keeps = (t: string): boolean => (t.length > 1 || /\d/.test(t)) && !STOPWORDS.has(t);

export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  if (!NEEDS_SEGMENTER.test(lower)) return (lower.match(TOKEN) ?? []).filter(keeps);
  const words: string[] = [];
  let currency = '';
  for (const part of SEGMENTER.segment(lower)) {
    if (!part.isWordLike) {
      // "€5,000" is one figure: the symbol is not word-like on its own, so it is carried over.
      currency = CURRENCY_SYMBOL.test(part.segment) ? part.segment : '';
      continue;
    }
    words.push(currency + part.segment);
    currency = '';
  }
  return words.filter(keeps);
}

/** Unique search terms from every query and the user's question, with operators removed. */
export function queryTerms(queries: SearchQuery[], question = ''): string[] {
  const text = [...queries.map((q) => q.q.replace(OPERATOR, ' ')), question].join(' ');
  return [...new Set(tokenize(text))];
}

/**
 * Picks the parts of a page that match the query, so the model reads evidence instead of a
 * whole page. Returns plain text passages in document order, within maxChars in total.
 */
export function selectPassages(
  doc: { content: string; summary: string; snippet: string },
  terms: string[],
  opts: { maxChars?: number; maxPassages?: number } = {},
): string[] {
  const maxChars = opts.maxChars ?? 1400;
  const maxPassages = opts.maxPassages ?? 3;
  const body = cleanContent(doc.content);
  const fallback = collapse(doc.summary) || collapse(doc.snippet);

  if (body.length < SHORT_DOC_CHARS) {
    const text = fallback || body;
    return text ? [clipWords(text, maxChars)] : [];
  }

  const words = body.split(' ');
  const windows = makeWindows(words);
  const scores = bm25(windows.map((w) => tokenize(w.text)), terms);
  // For price questions, a window that shows an actual number beats one that only talks about pricing.
  const boostPricing = terms.some((t) => PRICING.has(t));
  const top = windows
    .map((w, i) => ({ ...w, score: scores[i] * (boostPricing && CURRENCY_OR_NUMBER.test(w.text) ? 1.3 : 1) }))
    .filter((w) => w.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxPassages);

  if (top.length === 0) {
    return [clipWords(fallback || windows[0].text, maxChars)];
  }

  // Overlapping or touching windows read as one passage; merging avoids repeating sentences.
  const spans: Array<{ start: number; end: number }> = [];
  for (const w of top.sort((a, b) => a.start - b.start)) {
    const last = spans.at(-1);
    if (last && w.start <= last.end) last.end = Math.max(last.end, w.end);
    else spans.push({ start: w.start, end: w.end });
  }

  const out: string[] = [];
  let budget = maxChars;
  for (const s of spans) {
    if (budget <= 0) break;
    const text = clipWords(words.slice(s.start, s.end).join(' '), budget);
    out.push(text);
    budget -= text.length;
  }
  return out;
}

/** Cuts text to at most max characters at a word boundary. Never returns more than max. */
export function clipWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(0, max));
  const at = cut.lastIndexOf(' ');
  return (at > 0 ? cut.slice(0, at) : cut).trimEnd();
}

interface Window {
  start: number;
  end: number;
  text: string;
}

function makeWindows(words: string[]): Window[] {
  const out: Window[] = [];
  for (let start = 0; ; start += WINDOW_STRIDE) {
    const end = Math.min(words.length, start + WINDOW_WORDS);
    out.push({ start, end, text: words.slice(start, end).join(' ') });
    if (end >= words.length) return out;
  }
}

/** Okapi BM25 over the windows of one document, so IDF reflects how rare a term is in this page. */
function bm25(docs: string[][], terms: string[]): number[] {
  const n = docs.length;
  const avgLen = docs.reduce((sum, d) => sum + d.length, 0) / n;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);

  return docs.map((d) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const t of terms) {
      const f = tf.get(t) ?? 0;
      if (f === 0) continue;
      const dt = df.get(t) ?? 0;
      const idf = Math.log(1 + (n - dt + 0.5) / (dt + 0.5));
      score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.length) / avgLen));
    }
    return score;
  });
}

/** Strips markdown images and link targets, and drops nav-like lines (short, no digits). */
function cleanContent(md: string): string {
  return collapse(
    md
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .split('\n')
      .filter((line) => {
        const t = line.trim();
        return /\d/.test(t) || t.split(/\s+/).length > 3;
      })
      .join('\n'),
  );
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
