// Resolves time expressions ("last Tuesday", "3 November") against the user's clock.
// This is deterministic on purpose: LLMs get weekday and month arithmetic wrong, and this runs
// on the hot path, so it cannot wait for a model call.
import * as chrono from 'chrono-node';
import { DateTime } from 'luxon';
import type { Clock, TimeRef } from '../types.js';

const WEEKDAY = '(monday|tuesday|wednesday|thursday|friday|saturday|sunday)';
/**
 * Full names and the short forms people type ("last Tues", "on Thurs"). Short forms are only
 * read after "last", "on" or "this past": on their own, "sat" and "sun" are words.
 */
const WEEKDAY_ANY = '(mon(?:day)?|tue(?:s(?:day)?)?|wed(?:s|nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)';
const MONTH_NAME = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
/** Zones whose people write the month first (3/11 is 11 March). Everywhere else it's the day. */
const MONTH_FIRST_ZONES = /^(?:America\/(?:New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Detroit|Boise|Juneau|Sitka|Nome|Yakutat|Adak|Metlakatla|Menominee|Indiana\/|Kentucky\/|North_Dakota\/)|Pacific\/Honolulu|Asia\/Manila)/;
const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\b';
/** Words that make "the 3rd …" an item in a list rather than a day. */
const ORDINAL_NOUN = '(?:option|one|item|choice|pick|place|point|time|tool|answer|question|row|step|plan|tier|result|link|source|line|attempt)s?\\b';
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

/** Weekday numbers follow luxon: 1 = Monday ... 7 = Sunday. Short forms count ("Tues"). */
function weekdayNumber(name: string): number {
  return ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].indexOf(name.slice(0, 3).toLowerCase()) + 1;
}

function monthNumber(name: string): number {
  return ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(name.slice(0, 3).toLowerCase()) + 1;
}

/** A span cut to end at `today`, or null when it starts after today (memory holds only the past). */
function pastPart(first: DateTime, last: DateTime, today: DateTime): Span | null {
  if (first.toMillis() > today.toMillis()) return null;
  return { first, last: last.toMillis() > today.toMillis() ? today : last };
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
  scan(new RegExp(`\\b(?:next\\s+(?:week|weekend|month|${WEEKDAY_ANY})|tomorrow)\\b`, 'gi'), () => null);

  // "still correct today" asks about the present, not about a past day. Without this, a question
  // like "Is your answer still correct today?" would wrongly add a memory lookup for today.
  scan(/\b(?:still|correct|true|right|accurate|valid|current|up\s+to\s+date|as\s+of|case)\s+today\b/gi, () => null);

  scan(/\b(?:earlier\s+today|this\s+morning|this\s+afternoon|tonight|today)\b/gi, (m) =>
    spanRef(m[0], { first: today, last: today }),
  );

  // Before "yesterday", which would otherwise claim the end of the phrase.
  scan(/\b(?:the\s+)?day\s+before\s+yesterday\b/gi, (m) => {
    const d = today.minus({ days: 2 });
    return spanRef(m[0], { first: d, last: d });
  });

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

  // "A week ago" or "a fortnight ago" is rarely the exact day, so it reads as that day give or take three.
  scan(/\b(?:(a|an|one|two|three|four|\d{1,2})\s+weeks?|a\s+fortnight)\s+ago\b/gi, (m) => {
    const weeks = m[1] ? (NUMBER_WORDS[m[1].toLowerCase()] ?? Number(m[1])) : 2;
    const centre = today.minus({ weeks });
    const last = centre.plus({ days: 3 });
    return spanRef(m[0], { first: centre.minus({ days: 3 }), last: last < today ? last : today.minus({ days: 1 }) });
  });

  scan(/\bthe\s+other\s+week\b/gi, (m) => spanRef(m[0], { first: today.minus({ days: 21 }), last: today.minus({ days: 7 }) }));

  // The most recent Saturday and Sunday before today.
  scan(/\b(?:last|over\s+the|this\s+past|at\s+the|on\s+the)\s+weekend\b/gi, (m) => {
    const sunday = lastOccurrence(today, 7);
    return spanRef(m[0], { first: sunday.minus({ days: 1 }), last: sunday });
  });

  scan(/\b(?:earlier\s+)?this\s+week\b/gi, (m) => spanRef(m[0], { first: thisMonday, last: today }));

  scan(/\blast\s+week\b/gi, (m) =>
    spanRef(m[0], { first: thisMonday.minus({ weeks: 1 }), last: thisMonday.minus({ days: 1 }) }),
  );

  // Before "this month" and "last month", which would otherwise claim the end of the phrase.
  scan(/\b(?:at\s+)?the\s+(?:start|beginning)\s+of\s+(the|this|last)\s+month\b/gi, (m) => {
    const start = m[1]!.toLowerCase() === 'last' ? today.startOf('month').minus({ months: 1 }) : today.startOf('month');
    const past = pastPart(start, start.set({ day: 10 }), today);
    return past ? spanRef(m[0], past) : null;
  });

  scan(/\b(?:earlier\s+)?this\s+month\b/gi, (m) =>
    spanRef(m[0], { first: today.startOf('month'), last: today }),
  );

  scan(/\blast\s+month\b/gi, (m) => {
    const firstOfThis = today.startOf('month');
    return spanRef(m[0], { first: firstOfThis.minus({ months: 1 }), last: firstOfThis.minus({ days: 1 }) });
  });

  scan(new RegExp(`\\blast\\s+${WEEKDAY_ANY}\\b`, 'gi'), (m) => {
    const day = lastOccurrence(today, weekdayNumber(m[1]));
    // "Last Tuesday" said on a Thursday is most likely this week's Tuesday, but the user may
    // mean the one a week before, so both readings are kept and recall picks the one with evidence.
    const sameWeek = day.toMillis() >= thisMonday.toMillis();
    return spanRef(m[0], { first: day, last: day }, sameWeek ? [{ first: day.minus({ weeks: 1 }), last: day.minus({ weeks: 1 }) }] : undefined);
  });

  scan(new RegExp(`\\b(?:(?:on|this\\s+past)\\s+${WEEKDAY_ANY}|${WEEKDAY})\\b`, 'gi'), (m) => {
    const wd = weekdayNumber(m[1] ?? m[2]!);
    const day = lastOccurrence(today, wd);
    // A bare weekday that is today reads as a week back, and as today itself as well.
    const alternates = wd === today.weekday ? [{ first: today, last: today }] : undefined;
    return spanRef(m[0], { first: day, last: day }, alternates);
  });

  // A day of the month on its own ("on the 3rd") is the most recent such day: this month's if it
  // has come, otherwise last month's. "The 3rd of November" is left to chrono, and "the 3rd
  // option" is not a date. A month without that day ("the 31st" after November) is skipped.
  scan(
    new RegExp(`\\b(?:on|from|since)\\s+the\\s+(\\d{1,2})(?:st|nd|rd|th)\\b(?!\\s+(?:of\\s+)?${MONTH})(?!\\s+${ORDINAL_NOUN})`, 'gi'),
    (m) => {
      const dom = Number(m[1]);
      for (let back = 0; back < 3; back++) {
        const month = today.startOf('month').minus({ months: back });
        if (dom > month.daysInMonth!) continue;
        const day = month.set({ day: dom });
        if (day.toMillis() <= today.toMillis()) return spanRef(m[0], { first: day, last: day });
      }
      return null;
    },
  );

  // A month with no day: "in October", "back in March 2026", "early November". Early, mid and
  // late are the month's thirds. A month still to come this year is last year's.
  const monthRef = (m: RegExpMatchArray | RegExpExecArray, part: string | undefined, name: string, year: string | undefined): TimeRef | null => {
    const month = monthNumber(name);
    const from = part?.toLowerCase() === 'mid' ? 11 : part?.toLowerCase() === 'late' ? 21 : 1;
    const span = (y: number) => {
      const start = DateTime.fromObject({ year: y, month, day: 1 }, { zone }).startOf('day');
      const to = part?.toLowerCase() === 'early' ? 10 : part?.toLowerCase() === 'mid' ? 20 : start.daysInMonth!;
      return { first: start.set({ day: from }), last: start.set({ day: to }) };
    };
    let s = span(year ? Number(year) : today.year);
    if (!year && s.first.toMillis() > today.toMillis()) s = span(today.year - 1);
    const past = pastPart(s.first, s.last, today);
    return past ? spanRef(m[0], past) : null;
  };
  const NO_DAY_AFTER = '(?:,?\\s+(\\d{4}))?\\b(?!\\s*(?:\\d|the\\s+\\d))';
  scan(new RegExp(`\\b(?:(?:back\\s+)?in|during|over|throughout|from)\\s+(?:(early|mid|late)[-\\s]+)?${MONTH_NAME}${NO_DAY_AFTER}`, 'gi'), (m) =>
    monthRef(m, m[1], m[2]!, m[3]),
  );
  scan(new RegExp(`\\b(early|mid|late)[-\\s]+${MONTH_NAME}${NO_DAY_AFTER}`, 'gi'), (m) => monthRef(m, m[1], m[2]!, m[3]));

  // "On 3/11": the day first, as most of the world writes it, except where the month comes
  // first (the US). The other reading is kept too, and recall goes with the one that has a record.
  scan(/\b(?:on|from|since|dated)\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b(?![/\d])/gi, (m) => {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : null;
    const reading = (day: number, month: number): DateTime | null => {
      const make = (y: number) => DateTime.fromObject({ year: y, month, day }, { zone }).startOf('day');
      let d = make(year ?? today.year);
      if (!d.isValid) return null;
      if (year === null && d.toMillis() > today.toMillis()) d = make(today.year - 1);
      return d.isValid && d.toMillis() <= today.toMillis() ? d : null;
    };
    const dayFirst = reading(a, b);
    const monthFirst = reading(b, a);
    const [primary, other] = MONTH_FIRST_ZONES.test(zone) ? [monthFirst, dayFirst] : [dayFirst, monthFirst];
    const main = primary ?? other;
    if (!main) return null;
    const alt = primary && other && !other.hasSame(primary, 'day') ? [{ first: other, last: other }] : undefined;
    return spanRef(m[0], { first: main, last: main }, alt);
  });

  // Anything chrono finds that the rules above did not claim: "3 November", "12 Mar 2026",
  // "3 to 5 November". Chrono does not know the user's timezone, so the offset is passed in.
  const offsetMinutes = DateTime.fromJSDate(clock.now, { zone }).offset ?? 0;
  for (const r of chrono.parse(text, { instant: clock.now, timezone: offsetMinutes }, { forwardDate: false })) {
    if (!isFree(r.index, r.text.length)) continue;
    const s = r.start;
    // Times without a day ("at 3pm") are not date references.
    if (!s.isCertain('day')) continue;
    // A bare "3/4" is more often a fraction than a date, and chrono reads it month first. Dates
    // written this way after "on" or "since" were read above, the user's way round.
    if (/^\d{1,2}\/\d{1,2}$/.test(r.text.trim())) continue;

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
