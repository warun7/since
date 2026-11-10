// Resolves time expressions ("last Tuesday", "3 November") against the user's clock.
// This is deterministic on purpose: LLMs get weekday and month arithmetic wrong, and this runs
// on the hot path, so it cannot wait for a model call.
import * as chrono from 'chrono-node';
import { DateTime } from 'luxon';
import type { Clock, TimeRef } from '../types.js';

const WEEKDAY = '(monday|tuesday|wednesday|thursday|friday|saturday|sunday)';
const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/** A run of whole local days, both ends inclusive. */
interface Span {
  first: DateTime;
  last: DateTime;
}

/** A valid IANA zone, or UTC. Anything the browser sends is untrusted input. */
export function safeTz(tz: string | undefined): string {
  if (tz && DateTime.now().setZone(tz).isValid) return tz;
  return 'UTC';
}

/** Formats in English regardless of the server's locale, so labels are stable. */
function fmt(d: DateTime, format: string): string {
  return d.setLocale('en-US').toFormat(format);
}

/** ISO UTC with milliseconds, the same format Date.toISOString writes. Storage compares these as text. */
function iso(d: DateTime): string {
  return d.toJSDate().toISOString();
}

export function formatDay(isoStr: string, tz: string): string {
  return fmt(DateTime.fromISO(isoStr, { zone: safeTz(tz) }), 'ccc d LLL yyyy');
}

export function formatDateTime(isoStr: string, tz: string): string {
  return fmt(DateTime.fromISO(isoStr, { zone: safeTz(tz) }), 'ccc d LLL yyyy, HH:mm');
}

/** The UTC instants of a local day's midnight and the next local midnight. */
export function dayRange(dayStart: DateTime): { start: string; end: string } {
  const start = dayStart.startOf('day');
  // Adding a day in the local zone, rather than 24 hours, keeps this right across DST changes.
  return { start: iso(start), end: iso(start.plus({ days: 1 }).startOf('day')) };
}

function rangeLabel(first: DateTime, last: DateTime): string {
  if (first.hasSame(last, 'day')) return fmt(last, 'ccc d LLL yyyy');
  // The year is shown once at the end unless the range crosses a year boundary.
  const from = first.year === last.year ? fmt(first, 'ccc d LLL') : fmt(first, 'ccc d LLL yyyy');
  return `${from} – ${fmt(last, 'ccc d LLL yyyy')}`;
}

function spanRef(text: string, span: Span, alternates?: Span[]): TimeRef {
  const ref: TimeRef = {
    text,
    start: dayRange(span.first).start,
    end: dayRange(span.last).end,
    label: rangeLabel(span.first, span.last),
  };
  if (alternates?.length) {
    ref.alternates = alternates.map((a) => ({
      start: dayRange(a.first).start,
      end: dayRange(a.last).end,
      label: rangeLabel(a.first, a.last),
    }));
  }
  return ref;
}

/** Weekday numbers follow luxon: 1 = Monday ... 7 = Sunday. */
function weekdayNumber(name: string): number {
  return WEEKDAY.slice(1, -1).split('|').indexOf(name.toLowerCase()) + 1;
}

/** The most recent date strictly before today that falls on `weekday`. Today itself counts as 7 days back. */
function lastOccurrence(today: DateTime, weekday: number): DateTime {
  const back = (today.weekday - weekday + 7) % 7 || 7;
  return today.minus({ days: back });
}

/**
 * Finds the past days a message refers to. Future expressions ("next Tuesday", "tomorrow") are
 * dropped, since memory only holds the past. Results come back in text order, deduplicated by range.
 */
export function resolveTimeRefs(text: string, clock: Clock): TimeRef[] {
  const zone = safeTz(clock.tz);
  const today = DateTime.fromJSDate(clock.now, { zone }).startOf('day');
  // luxon weeks start on Monday, which is the ISO week the spec's "last week" refers to.
  const thisMonday = today.startOf('week');

  const found: Array<{ index: number; ref: TimeRef }> = [];
  // Each rule claims the text it matched. Later rules skip text already claimed, so a phrase
  // like "last Tuesday" is not also read as a bare "Tuesday", and chrono does not re-read it.
  const taken: Array<[number, number]> = [];
  const isFree = (index: number, length: number) =>
    !taken.some(([a, b]) => index < b && a < index + length);

  // scan(pattern, handle): handle returns a ref, or null to claim the text and emit nothing.
  const scan = (re: RegExp, handle: (m: RegExpExecArray | RegExpMatchArray) => TimeRef | null) => {
    for (const m of text.matchAll(re)) {
      const index = m.index ?? 0;
      if (!isFree(index, m[0].length)) continue;
      taken.push([index, index + m[0].length]);
      const ref = handle(m);
      if (ref) found.push({ index, ref });
    }
  };

  // Future phrases are claimed (and dropped) first, so chrono cannot resolve them to the past.
  scan(new RegExp(`\\b(?:next\\s+(?:week|month|${WEEKDAY})|tomorrow)\\b`, 'gi'), () => null);

  // "still correct today" asks about the present, not about a past day. Without this, a question
  // like "Is your answer still correct today?" would wrongly add a memory lookup for today.
  scan(/\b(?:still|correct|true|right|accurate|valid|current|up\s+to\s+date|as\s+of|case)\s+today\b/gi, () => null);

  scan(/\b(?:earlier\s+today|this\s+morning|this\s+afternoon|tonight|today)\b/gi, (m) =>
    spanRef(m[0], { first: today, last: today }),
  );

  scan(/\byesterday\b/gi, (m) => {
    const d = today.minus({ days: 1 });
    return spanRef(m[0], { first: d, last: d });
  });

  scan(/\b(?:a\s+few\s+days\s+ago|the\s+other\s+day)\b/gi, (m) =>
    // "Before today" for a range of 5 days: today-5 through today-1, inclusive.
    spanRef(m[0], { first: today.minus({ days: 5 }), last: today.minus({ days: 1 }) }),
  );

  scan(/\b(\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+days?\s+ago\b/gi, (m) => {
    const n = NUMBER_WORDS[m[1].toLowerCase()] ?? Number(m[1]);
    const d = today.minus({ days: n });
    return spanRef(m[0], { first: d, last: d });
  });

  scan(/\b(?:earlier\s+)?this\s+week\b/gi, (m) => spanRef(m[0], { first: thisMonday, last: today }));

  scan(/\blast\s+week\b/gi, (m) =>
    spanRef(m[0], { first: thisMonday.minus({ weeks: 1 }), last: thisMonday.minus({ days: 1 }) }),
  );

  scan(/\b(?:earlier\s+)?this\s+month\b/gi, (m) =>
    spanRef(m[0], { first: today.startOf('month'), last: today }),
  );

  scan(/\blast\s+month\b/gi, (m) => {
    const firstOfThis = today.startOf('month');
    return spanRef(m[0], { first: firstOfThis.minus({ months: 1 }), last: firstOfThis.minus({ days: 1 }) });
  });

  scan(new RegExp(`\\blast\\s+${WEEKDAY}\\b`, 'gi'), (m) => {
    const day = lastOccurrence(today, weekdayNumber(m[1]));
    // "Last Tuesday" said on a Thursday is most likely this week's Tuesday, but the user may
    // mean the one a week before, so both readings are kept and recall picks the one with evidence.
    const sameWeek = day.toMillis() >= thisMonday.toMillis();
    return spanRef(m[0], { first: day, last: day }, sameWeek ? [{ first: day.minus({ weeks: 1 }), last: day.minus({ weeks: 1 }) }] : undefined);
  });

  scan(new RegExp(`\\b(?:on\\s+)?${WEEKDAY}\\b`, 'gi'), (m) => {
    const wd = weekdayNumber(m[1]);
    const day = lastOccurrence(today, wd);
    // A bare weekday that is today reads as a week back, and as today itself as well.
    const alternates = wd === today.weekday ? [{ first: today, last: today }] : undefined;
    return spanRef(m[0], { first: day, last: day }, alternates);
  });

  // Anything chrono finds that the rules above did not claim: "3 November", "12 Mar 2026",
  // "3 to 5 November". Chrono does not know the user's timezone, so the offset is passed in.
  const offsetMinutes = DateTime.fromJSDate(clock.now, { zone }).offset ?? 0;
  for (const r of chrono.parse(text, { instant: clock.now, timezone: offsetMinutes }, { forwardDate: false })) {
    if (!isFree(r.index, r.text.length)) continue;
    const s = r.start;
    // Times without a day ("at 3pm") are not date references.
    if (!s.isCertain('day')) continue;

    const dayOf = (c: typeof s, year: number | null): DateTime => {
      const month = c.get('month');
      const dom = c.get('day');
      if (year == null || month == null || dom == null) return DateTime.invalid('incomplete date');
      return DateTime.fromObject({ year, month, day: dom }, { zone }).startOf('day');
    };
    let first = dayOf(s, s.get('year'));
    if (!first.isValid) continue;
    // With no year written, chrono picks the year of the clock, so a day that lands after today
    // means the most recent such day was last year ("3 November" on 5 Jan 2027 = 3 Nov 2026).
    if (!s.isCertain('year') && first.toMillis() > today.toMillis()) first = first.minus({ years: 1 });
    if (first.toMillis() > today.toMillis()) continue;

    let last = first;
    const e = r.end;
    if (e?.isCertain('day')) {
      let endDay = dayOf(e, e.isCertain('year') ? e.get('year') : first.year);
      if (endDay.isValid && endDay.toMillis() < first.toMillis()) endDay = endDay.plus({ years: 1 });
      // A range that runs into the future stops at today: the memory has nothing after it.
      if (endDay.isValid) last = endDay.toMillis() <= today.toMillis() ? endDay : today;
    }
    taken.push([r.index, r.index + r.text.length]);
    found.push({ index: r.index, ref: spanRef(r.text, { first, last }) });
  }

  found.sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  return found
    .map((f) => f.ref)
    .filter((ref) => {
      const key = `${ref.start}|${ref.end}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** The current date and, next to it, the 13 days before it, one per line, newest first. */
export function calendarBlock(clock: Clock, days = 14): string {
  const zone = safeTz(clock.tz);
  const today = DateTime.fromJSDate(clock.now, { zone }).startOf('day');
  const lines = [`Calendar for working out dates, not a record of conversations (user's timezone, ${zone}):`];
  for (let i = 0; i < days; i++) {
    const label = fmt(today.minus({ days: i }), 'ccc d LLL yyyy');
    lines.push(i === 0 ? `${label} (today)` : i === 1 ? `${label} (yesterday)` : label);
  }
  return lines.join('\n');
}
