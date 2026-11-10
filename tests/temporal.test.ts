import { describe, expect, it } from 'vitest';
import { calendarBlock, formatDateTime, formatDay, resolveTimeRefs, safeTz } from '../src/memory/temporal.js';
import type { Clock } from '../src/types.js';

// Tue 10 Nov 2026, 15:30 in London (GMT, so UTC+0).
const tuesday: Clock = { now: new Date('2026-11-10T15:30:00Z'), tz: 'Europe/London' };

describe('resolveTimeRefs', () => {
  it('resolves a day-month reference and ignores "today" used as "still correct today"', () => {
    const refs = resolveTimeRefs('What did I ask you on 3 November? Is your answer still correct today?', tuesday);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      label: 'Tue 3 Nov 2026',
      start: '2026-11-03T00:00:00.000Z',
      end: '2026-11-04T00:00:00.000Z',
    });
    expect(refs[0].alternates).toBeUndefined();
  });

  it('resolves "last Tuesday" on a Tuesday to a week back, with no alternates', () => {
    const refs = resolveTimeRefs('Last Tuesday I asked you about Postgres hosting', tuesday);
    expect(refs).toHaveLength(1);
    expect(refs[0].label).toBe('Tue 3 Nov 2026');
    expect(refs[0].alternates).toBeUndefined();
  });

  it('resolves a bare weekday to the most recent past occurrence', () => {
    const refs = resolveTimeRefs('On Monday we shortlisted 5 CRM tools', tuesday);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ label: 'Mon 9 Nov 2026', start: '2026-11-09T00:00:00.000Z' });
  });

  it('gives "last Tuesday" said on Thursday both this week and last week', () => {
    const thursday: Clock = { now: new Date('2026-11-12T10:00:00Z'), tz: 'Europe/London' };
    const [ref] = resolveTimeRefs('last Tuesday', thursday);
    expect(ref.label).toBe('Tue 10 Nov 2026');
    expect(ref.alternates).toEqual([
      { start: '2026-11-03T00:00:00.000Z', end: '2026-11-04T00:00:00.000Z', label: 'Tue 3 Nov 2026' },
    ]);
  });

  it('resolves "yesterday"', () => {
    const [ref] = resolveTimeRefs('what did we say yesterday', tuesday);
    expect(ref.label).toBe('Mon 9 Nov 2026');
    expect(ref.start).toBe('2026-11-09T00:00:00.000Z');
  });

  it('resolves "N days ago"', () => {
    const [ref] = resolveTimeRefs('3 days ago you listed some options', tuesday);
    expect(ref.label).toBe('Sat 7 Nov 2026');
  });

  it('resolves "last week" to the previous Monday..Sunday', () => {
    const [ref] = resolveTimeRefs('what came up last week', tuesday);
    expect(ref.label).toBe('Mon 2 Nov – Sun 8 Nov 2026');
    expect(ref.start).toBe('2026-11-02T00:00:00.000Z');
    expect(ref.end).toBe('2026-11-09T00:00:00.000Z');
  });

  it('resolves "earlier this week" to Monday through today', () => {
    const [ref] = resolveTimeRefs('earlier this week', tuesday);
    expect(ref.label).toBe('Mon 9 Nov – Tue 10 Nov 2026');
    expect(ref.start).toBe('2026-11-09T00:00:00.000Z');
    expect(ref.end).toBe('2026-11-11T00:00:00.000Z');
  });

  it('means last year for a day-month that would fall after today', () => {
    const jan: Clock = { now: new Date('2027-01-05T12:00:00Z'), tz: 'Europe/London' };
    const [ref] = resolveTimeRefs('on 3 November', jan);
    expect(ref.label).toBe('Tue 3 Nov 2026');
  });

  it('uses the user timezone for day boundaries', () => {
    // 06:00 UTC on Tue 10 Nov is 22:00 on Mon 9 Nov in Los Angeles (PST).
    const la: Clock = { now: new Date('2026-11-10T06:00:00Z'), tz: 'America/Los_Angeles' };
    const [ref] = resolveTimeRefs('yesterday', la);
    expect(ref.label).toBe('Sun 8 Nov 2026');
    expect(ref.start).toBe('2026-11-08T08:00:00.000Z');
  });

  it('resolves a day of the month on its own to the most recent such day', () => {
    expect(resolveTimeRefs('Remind me what we went over on the 3rd, and does it still hold?', tuesday).map((r) => r.label)).toEqual(['Tue 3 Nov 2026']);
    // The 20th hasn't come this month, so it is last month's.
    expect(resolveTimeRefs('since the 20th', tuesday).map((r) => r.label)).toEqual(['Tue 20 Oct 2026']);
    // On 10 Oct, the 31st hasn't come and September has none, so "the 31st" is 31 Aug.
    const oct: Clock = { now: new Date('2026-10-10T12:00:00Z'), tz: 'Europe/London' };
    expect(resolveTimeRefs('on the 31st', oct).map((r) => r.label)).toEqual(['Mon 31 Aug 2026']);
  });

  it('leaves "the 3rd of November" to the day-month rule and "the 3rd option" alone', () => {
    expect(resolveTimeRefs('on the 3rd of November', tuesday).map((r) => r.label)).toEqual(['Tue 3 Nov 2026']);
    expect(resolveTimeRefs('I went with the one on the 3rd option', tuesday)).toEqual([]);
  });

  const labels = (text: string, clock: Clock = tuesday) => resolveTimeRefs(text, clock).map((r) => r.label);

  it('reads "the day before yesterday" as two days back, not as yesterday', () => {
    expect(labels('the day before yesterday you told me')).toEqual(['Sun 8 Nov 2026']);
  });

  it('reads short day names after "last" or "on", but not "sat" or "sun" as words', () => {
    expect(labels('last Tues')).toEqual(['Tue 3 Nov 2026']);
    expect(labels('on Thurs we shortlisted')).toEqual(['Thu 5 Nov 2026']);
    expect(labels('I sat down with the team and the sun came out')).toEqual([]);
  });

  it('reads weekends, weeks ago and "the other week" as spans', () => {
    expect(labels('over the weekend')).toEqual(['Sat 7 Nov – Sun 8 Nov 2026']);
    // A fortnight back is Tue 27 Oct, give or take three days.
    expect(labels('a fortnight ago')).toEqual(['Sat 24 Oct – Fri 30 Oct 2026']);
    expect(labels('the other week')).toEqual(['Tue 20 Oct – Tue 3 Nov 2026']);
    expect(labels('next weekend')).toEqual([]);
  });

  it('reads a month with no day, and its early, mid or late part', () => {
    expect(labels('back in October')).toEqual(['Thu 1 Oct – Sat 31 Oct 2026']);
    // Early November runs to the 10th, which is today.
    expect(labels('in early November')).toEqual(['Sun 1 Nov – Tue 10 Nov 2026']);
    expect(labels('in March 2025')).toEqual(['Sat 1 Mar – Mon 31 Mar 2025']);
    expect(labels('at the start of last month')).toEqual(['Thu 1 Oct – Sat 10 Oct 2026']);
    expect(labels('you may have said')).toEqual([]);
  });

  it("reads 3/11 the user's way round, and keeps the other reading", () => {
    const [ldn] = resolveTimeRefs('what did I ask on 3/11?', tuesday);
    expect(ldn).toMatchObject({ label: 'Tue 3 Nov 2026', alternates: [{ label: 'Wed 11 Mar 2026' }] });
    const ny: Clock = { now: tuesday.now, tz: 'America/New_York' };
    const [us] = resolveTimeRefs('what did I ask on 3/11?', ny);
    expect(us).toMatchObject({ label: 'Wed 11 Mar 2026', alternates: [{ label: 'Tue 3 Nov 2026' }] });
    expect(labels('on 13/10')).toEqual(['Tue 13 Oct 2026']);
  });

  it('leaves a fraction alone', () => {
    expect(labels('what is 3/4 of 200?')).toEqual([]);
  });

  it('returns nothing for a message with no time reference', () => {
    expect(resolveTimeRefs("What's the weather like?", tuesday)).toEqual([]);
  });

  it('drops future references', () => {
    expect(resolveTimeRefs('next Tuesday', tuesday)).toEqual([]);
  });
});

describe('calendarBlock', () => {
  it('lists days newest first, labelled today and yesterday', () => {
    const lines = calendarBlock(tuesday, 3).split('\n');
    expect(lines).toEqual([
      "Calendar for working out dates, not a record of conversations (user's timezone, Europe/London):",
      'Tue 10 Nov 2026 (today)',
      'Mon 9 Nov 2026 (yesterday)',
      'Sun 8 Nov 2026',
    ]);
  });
});

describe('formatting and zones', () => {
  it('formats days and date-times in the given zone', () => {
    expect(formatDay('2026-11-03T00:00:00.000Z', 'Europe/London')).toBe('Tue 3 Nov 2026');
    expect(formatDateTime('2026-11-10T10:14:00.000Z', 'Europe/London')).toBe('Tue 10 Nov 2026, 10:14');
  });

  it('falls back to UTC for an unknown zone', () => {
    expect(safeTz('Not/AZone')).toBe('UTC');
    expect(safeTz(undefined)).toBe('UTC');
    expect(safeTz('Asia/Tokyo')).toBe('Asia/Tokyo');
  });
});
