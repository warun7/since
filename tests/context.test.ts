import { describe, expect, it } from 'vitest';
import { contextMessage } from '../src/agent/context.js';
import type { Clock, MemoryHit, RecallResult } from '../src/types.js';

const clock: Clock = { now: new Date('2026-11-10T15:30:00Z'), tz: 'Europe/London' };
const nov3 = { text: 'on 3 November', start: '2026-11-03T00:00:00.000Z', end: '2026-11-04T00:00:00.000Z', label: 'Tue 3 Nov 2026' };

const hit: MemoryHit = {
  messageId: 'm1',
  conversationId: 'c1',
  askedAt: '2026-11-03T10:14:00.000Z',
  question: 'Cheapest managed Postgres?',
  answer: 'Neon Launch is about $15/month [1], Supabase Pro $25 [2].',
  summary: null,
  topics: [],
  entities: ['Neon', 'Supabase'],
  claims: [{ subject: 'Supabase', attribute: 'Pro price', value: '$25/month', sourceUrl: 'https://supabase.com/pricing', asOf: '2026-11-03T10:14:00.000Z' }],
  sources: [{ n: 1, url: 'https://neon.com/pricing', title: 'Neon pricing', site: 'neon.com' }],
  conversationTitle: 'Postgres hosting',
  matchedBy: ['date'],
  score: 10,
};

function memory(over: Partial<RecallResult>): RecallResult {
  return { refs: [], hits: [], emptyRefs: [], index: [], firstMemoryAt: '2026-11-03T10:14:00.000Z', ms: 1, ...over };
}

describe('contextMessage', () => {
  it('says plainly when a named date has no conversations', () => {
    const text = contextMessage({ clock, memory: memory({ refs: [nov3], emptyRefs: [nov3] }), conversationSources: [], inHistory: new Set() });
    expect(text).toContain('"on 3 November" = Tue 3 Nov 2026 — NO conversations with the user on this date');
    expect(text).toContain('Now: Tue 10 Nov 2026, 15:30 (Europe/London); ISO date 2026-11-10');
  });

  it('gives a retrieved exchange with its claims, minus the old citation numbers', () => {
    const text = contextMessage({ clock, memory: memory({ refs: [nov3], hits: [hit] }), conversationSources: [], inHistory: new Set() });
    expect(text).toContain('### Tue 3 Nov 2026, 10:14 (2026-11-03)');
    expect(text).toContain('Neon Launch is about $15/month, Supabase Pro $25.');
    expect(text).toContain('- Supabase · Pro price: $25/month (source: https://supabase.com/pricing)');
    expect(text).not.toContain('[1]');
  });

  it('says how many exchanges a named date holds, so the model never infers "no record"', () => {
    const second = { ...hit, messageId: 'm2', askedAt: '2026-11-03T16:40:00.000Z', question: 'Is Bun production-ready?' };
    const text = contextMessage({ clock, memory: memory({ refs: [nov3], hits: [hit, second] }), conversationSources: [], inHistory: new Set() });
    expect(text).toContain('"on 3 November" = Tue 3 Nov 2026 — 2 past exchanges with the user on this date');
  });

  it("doesn't repeat an exchange that is already in the conversation history", () => {
    const text = contextMessage({ clock, memory: memory({ hits: [hit] }), conversationSources: [], inHistory: new Set(['m1']) });
    expect(text).not.toContain('Cheapest managed Postgres?');
  });

  it('tells a brand-new user apart from an empty day', () => {
    const text = contextMessage({ clock, memory: memory({ firstMemoryAt: null }), conversationSources: [], inHistory: new Set() });
    expect(text).toContain('You have no past conversations with this user yet.');
  });
});
