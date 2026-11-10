// Finds the past exchanges a message refers to, by date and by topic. No model calls.
import type { MemoryStore } from './store.js';
import { resolveTimeRefs } from './temporal.js';
import type { Clock, MemoryHit, RecallResult, TimeRef, TurnMemory } from '../types.js';

const WORD_RE = /[\p{L}\p{N}]+/gu;

/** Words that carry no topic: English function words, plus the conversational and time words of memory questions. */
const STOPWORDS = new Set(
  `
  a an and are as at be been being but by can could did do does doing for from had has have
  having how i if in into is it its just me more most my no not of off on or our out over
  should so some such than that the their them then there these they this those through to
  too under until up us very was we were what when where which while who why will with would
  you your also about above after again against all any both down during each few further
  here once only other own same she her him his only
  ask asked tell told said say answer answered still correct right true today yesterday since
  then last week month ago earlier before remember changed change anything something
  monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat sun
  january february march april may june july august september october november december
  jan feb mar apr may jun jul aug sep sept oct nov dec
  `
    .trim()
    .split(/\s+/),
);

/** Lowercased word tokens, minus stopwords and short words. At most 12, in text order. */
export function keywords(text: string): string[] {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(WORD_RE) ?? []) {
    if (out.size >= 12) break;
    if (STOPWORDS.has(w)) continue;
    // "crm" and "postgres" are kept, "is" and "to" are not. A short word stays only if it has a digit.
    if (w.length < 3 && !/\d/.test(w)) continue;
    out.add(w);
  }
  return [...out];
}

// Phrases that signal the user is talking about something they had with the assistant before.
const CUE_PATTERNS: RegExp[] = [
  /\b(i|we)\s+(asked|discussed|talked|shortlisted|looked|compared|mentioned|said|decided|picked|chose|went with|were looking)\b/i,
  /\byou\s+(said|told|recommended|suggested|answered|gave|mentioned|found|listed|showed)\b/i,
  /\b(earlier|last time|previously|before|again|since then|changed since|still (correct|true|accurate|valid|right|the case|up to date))\b/i,
  /\b(our|that|the)\s+(shortlist|list|conversation|chat|discussion|comparison)\b/i,
  /\bremember\b/i,
];

export function hasMemoryCue(text: string): boolean {
  return CUE_PATTERNS.some((re) => re.test(text));
}

/** How many of the terms appear in the text. A term matches a whole word, or a word it starts, e.g. "shortlist" in "shortlisted". */
function countTerms(terms: string[], text: string): number {
  const tokens = text.toLowerCase().match(WORD_RE) ?? [];
  return terms.filter((t) => tokens.some((tok) => tok === t || (t.length >= 4 && tok.startsWith(t)))).length;
}

const MAX_TURNS_PER_DATE = 6;
const MAX_HITS = 6;

type Turn = TurnMemory & { conversationTitle: string | null };

/** Adds a turn to the hits, or, when it is already there, records the second way it was found. */
function addHit(hits: Map<string, MemoryHit>, t: Turn, by: 'date' | 'keywords', score: number): void {
  const existing = hits.get(t.messageId);
  if (!existing) {
    hits.set(t.messageId, {
      messageId: t.messageId,
      conversationId: t.conversationId,
      askedAt: t.askedAt,
      question: t.question,
      answer: t.answer,
      summary: t.summary,
      topics: t.topics,
      entities: t.entities,
      claims: t.claims,
      sources: t.sources,
      conversationTitle: t.conversationTitle,
      matchedBy: [by],
      score,
    });
    return;
  }
  if (existing.matchedBy.includes(by)) {
    // The same turn found twice by the same route (overlapping date ranges) is one hit, not two.
    existing.score = Math.max(existing.score, score);
    return;
  }
  existing.matchedBy.push(by);
  existing.score += score;
}

export function recall(
  store: MemoryStore,
  message: string,
  clock: Clock,
  opts: { conversationId?: string } = {},
): RecallResult {
  const started = performance.now();
  const resolved = resolveTimeRefs(message, clock);
  // Topic words come from the message minus its date phrases: the "3" in "3 November" is not a topic.
  const terms = keywords(resolved.reduce((text, r) => text.replace(r.text, ' '), message));
  const hits = new Map<string, MemoryHit>();
  const refs: TimeRef[] = [];
  const emptyRefs: TimeRef[] = [];

  // 1. Date hits: every past day the message names.
  for (const original of resolved) {
    let ref = original;
    let turns = store.turnsBetween(ref.start, ref.end);
    // "Last Tuesday" said on a Thursday may mean the Tuesday of this week or of last week. Use
    // whichever reading has stored turns; the ref returned to the caller is the one that matched.
    if (turns.length === 0 && ref.alternates) {
      for (const alt of ref.alternates) {
        const found = store.turnsBetween(alt.start, alt.end);
        if (found.length > 0) {
          ref = { text: original.text, start: alt.start, end: alt.end, label: alt.label };
          turns = found;
          break;
        }
      }
    }
    refs.push(ref);
    if (turns.length === 0) {
      emptyRefs.push(ref);
      continue;
    }

    // A busy day can have many turns. Keep the ones that share most words with the message, then the latest.
    const ranked = turns
      .map((t) => ({ t, overlap: countTerms(terms, [t.question, t.answer, t.summary ?? ''].join(' ')) }))
      .sort((a, b) => b.overlap - a.overlap || b.t.askedAt.localeCompare(a.t.askedAt))
      .slice(0, MAX_TURNS_PER_DATE);
    // When the message names a topic too ("last Tuesday ... about Postgres"), other exchanges from
    // that day are noise: keep the ones that match at least half as well as the best. With no topic
    // words ("what did I ask on 3 November?") every exchange that day is the answer.
    const best = ranked[0]?.overlap ?? 0;
    const relevant = best > 0 ? ranked.filter((r) => r.overlap >= Math.max(1, Math.ceil(best / 2))) : ranked;
    // Date hits score above any keyword hit (10 + overlap, against an overlap of a few words), so a
    // turn the user pointed to by date always ranks first.
    for (const { t, overlap } of relevant) addHit(hits, t, 'date', 10 + overlap);
  }

  const dateHits = [...hits.values()].filter((h) => h.matchedBy.includes('date'));
  const hasDateHits = dateHits.length > 0;
  const bestDateOverlap = Math.max(0, ...dateHits.map((h) => h.score - 10));

  // 2. Keyword hits: earlier answers on the same topic. How many to add depends on what the
  // message already gave us. Date hits are the strongest evidence, so keywords only supplement them.
  const keywordHits = store.searchTurns(terms, { limit: 8, excludeConversationId: opts.conversationId });
  let minOverlap: number;
  let cap: number;
  if (refs.length > 0 && hasDateHits) {
    // The date already found the exchange. Another one has to match the message at least as well
    // as that one does, or it's sharing generic words ("team", "pricing"), not the topic.
    minOverlap = Math.max(3, bestDateOverlap);
    cap = 2;
  } else if (refs.length > 0 || hasMemoryCue(message)) {
    // The user is clearly looking back ("the Postgres answer you gave") but gave no usable date.
    minOverlap = 1;
    cap = 4;
  } else {
    // No date, no cue: a same-topic answer is useful context, but only with a strong match.
    minOverlap = 2;
    cap = 2;
  }
  let added = 0;
  for (const k of keywordHits) {
    const overlap = countTerms(terms, [k.question, k.answer, k.summary ?? '', k.entities.join(' ')].join(' '));
    // A turn that is already a date hit is merged in regardless of the thresholds above.
    if (hits.has(k.messageId)) {
      addHit(hits, k, 'keywords', overlap);
      continue;
    }
    if (overlap < minOverlap || added >= cap) continue;
    addHit(hits, k, 'keywords', overlap);
    added++;
  }

  const sorted = [...hits.values()]
    .sort((a, b) => b.score - a.score || b.askedAt.localeCompare(a.askedAt))
    .slice(0, MAX_HITS);

  return {
    refs,
    hits: sorted,
    emptyRefs,
    index: store.recentConversations(15, opts.conversationId),
    firstMemoryAt: store.firstTurnAt(),
    ms: Math.round(performance.now() - started),
  };
}
