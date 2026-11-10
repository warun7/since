import { describe, expect, it } from 'vitest';
import { openDb } from '../src/memory/db.js';
import { MemoryStore } from '../src/memory/store.js';
import { recall } from '../src/memory/recall.js';
import { processTurn, writeMemoryNotes } from '../src/memory/writer.js';
import type { Clock, SourceSummary, TurnMemory } from '../src/types.js';

const tuesday: Clock = { now: new Date('2026-11-10T15:30:00Z'), tz: 'Europe/London' };
const thursday: Clock = { now: new Date('2026-11-12T10:00:00Z'), tz: 'Europe/London' };

function newStore(): MemoryStore {
  return new MemoryStore(openDb(':memory:'));
}

/** Writes a question/answer exchange at a fixed time, the way the agent does after an answer. */
function seedExchange(
  store: MemoryStore,
  conversationId: string,
  at: string,
  turn: { question: string; answer: string; entities?: string[]; summary?: string },
): string {
  const msg = store.addMessage({
    conversationId,
    role: 'assistant',
    content: turn.answer,
    createdAt: new Date(at),
  });
  store.saveTurn({
    messageId: msg.id,
    conversationId,
    askedAt: msg.createdAt,
    question: turn.question,
    answer: turn.answer,
    summary: turn.summary ?? null,
    topics: [],
    entities: turn.entities ?? [],
    claims: [],
    sources: [],
  });
  return msg.id;
}

/** The Postgres hosting exchange (Tue 3 Nov) and the CRM shortlist (Mon 9 Nov). */
function seedBoth(store: MemoryStore) {
  const work = store.createConversation(new Date('2026-11-03T09:00:00Z'));
  const pg = seedExchange(store, work.id, '2026-11-03T10:14:00Z', {
    question: 'Which hosting should I use for Postgres on a small side project?',
    answer: "Neon's free tier is enough to start. Supabase is a good alternative with more built-in features.",
    entities: ['Neon', 'Supabase'],
  });
  const sales = store.createConversation(new Date('2026-11-09T14:00:00Z'));
  const crm = seedExchange(store, sales.id, '2026-11-09T14:00:00Z', {
    question: 'Shortlist CRM tools for a small sales team',
    answer: 'Five options stand out: HubSpot, Pipedrive, Zoho CRM, Close and Freshsales.',
    entities: ['HubSpot', 'Pipedrive', 'Zoho CRM', 'Close', 'Freshsales'],
  });
  return { work, sales, pg, crm };
}

describe('MemoryStore round trips', () => {
  it('stores messages with sources and trace, and reads them back', () => {
    const store = newStore();
    const conv = store.createConversation(new Date('2026-11-03T09:00:00Z'));
    const sources: SourceSummary[] = [
      { n: 1, url: 'https://neon.tech/pricing', title: 'Neon pricing', site: 'neon.tech' },
    ];
    const trace = {
      model: 'deepseek-flash',
      steps: [],
      timings: { recallMs: 1, firstTokenMs: null, searchMs: 0, totalMs: 5 },
      usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 0 },
      recall: { hits: 0, refs: [], emptyRefs: [] },
    };
    store.addMessage({ conversationId: conv.id, role: 'user', content: 'hi', createdAt: new Date('2026-11-03T09:00:01Z') });
    const reply = store.addMessage({
      conversationId: conv.id,
      role: 'assistant',
      content: 'hello [1]',
      createdAt: new Date('2026-11-03T09:00:02Z'),
      sources,
      trace,
    });

    const messages = store.getMessages(conv.id);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1]).toMatchObject({ id: reply.id, content: 'hello [1]', sources, trace });
    // Optional fields that were never set are absent, not present as undefined.
    expect('verification' in messages[0]).toBe(false);
    expect('sources' in messages[0]).toBe(false);
  });

  it('records a verification on a message', () => {
    const store = newStore();
    const conv = store.createConversation();
    const msg = store.addMessage({ conversationId: conv.id, role: 'assistant', content: 'x' });
    store.setVerification(msg.id, { status: 'ok', supported: 2, cited: 2, flagged: [], ms: 12 });
    expect(store.getMessages(conv.id)[0].verification).toMatchObject({ status: 'ok', supported: 2 });
  });

  it('upserts sources by conversation and number', () => {
    const store = newStore();
    const conv = store.createConversation();
    const base = { url: 'https://a.example', title: 'A', site: 'a.example', passages: ['p1'] };
    store.saveSources(conv.id, [
      { n: 2, ...base, url: 'https://b.example', title: 'B', site: 'b.example' },
      { n: 1, ...base },
    ]);
    store.saveSources(conv.id, [{ n: 1, ...base, title: 'A (updated)', authority: 4 }]);

    const sources = store.getSources(conv.id);
    expect(sources.map((s) => s.n)).toEqual([1, 2]);
    expect(sources[0]).toMatchObject({ title: 'A (updated)', authority: 4, passages: ['p1'] });
    expect(sources[0].published).toBeUndefined();
  });

  it('counts turns per conversation and hides conversations without messages', () => {
    const store = newStore();
    const { work } = seedBoth(store);
    store.createConversation(); // empty: must not be listed
    seedExchange(store, work.id, '2026-11-04T10:00:00Z', { question: 'follow up', answer: 'answer' });

    const list = store.listConversations();
    expect(list).toHaveLength(2);
    expect(list.find((c) => c.id === work.id)?.turns).toBe(2);
    expect(list[0].updatedAt >= list[1].updatedAt).toBe(true);
  });

  it('deletes a conversation and its search rows', () => {
    const store = newStore();
    const { sales } = seedBoth(store);
    expect(store.searchTurns(['pipedrive'])).toHaveLength(1);

    store.deleteConversation(sales.id);
    expect(store.getConversation(sales.id)).toBeNull();
    expect(store.searchTurns(['pipedrive'])).toEqual([]);
    expect(store.getMessages(sales.id)).toEqual([]);
  });

  it('finds a turn by an entity added through updateTurnNotes', () => {
    const store = newStore();
    const conv = store.createConversation();
    const id = seedExchange(store, conv.id, '2026-11-05T10:00:00Z', { question: 'Which edge platform?', answer: 'Pick one that fits.' });
    expect(store.searchTurns(['vercel'])).toEqual([]);

    store.updateTurnNotes(id, { summary: 'Compared platforms.', topics: ['hosting'], entities: ['Vercel'], claims: [] });
    const [hit] = store.searchTurns(['vercel']);
    expect(hit).toMatchObject({ messageId: id, summary: 'Compared platforms.', entities: ['Vercel'] });
    expect(hit.score).toBeGreaterThan(0);
  });

  it('excludes the given conversation from keyword search and survives odd terms', () => {
    const store = newStore();
    const { work, pg } = seedBoth(store);
    expect(store.searchTurns(['postgres'], { excludeConversationId: work.id })).toEqual([]);
    expect(store.searchTurns(['postgres'])[0].messageId).toBe(pg);
    expect(() => store.searchTurns(['"', 'AND', '('])).not.toThrow();
    expect(store.searchTurns([])).toEqual([]);
  });

  it('returns turns between two instants, start inclusive and end exclusive', () => {
    const store = newStore();
    seedBoth(store);
    const day3 = store.turnsBetween('2026-11-03T00:00:00.000Z', '2026-11-04T00:00:00.000Z');
    expect(day3.map((t) => t.question)).toEqual(['Which hosting should I use for Postgres on a small side project?']);
    expect(day3[0].conversationTitle).toBeNull();
    expect(store.turnsBetween('2026-11-04T00:00:00.000Z', '2026-11-09T14:00:00.000Z')).toEqual([]);
    expect(store.firstTurnAt()).toBe('2026-11-03T10:14:00.000Z');
  });
});

describe('recall', () => {
  it('finds the Postgres turn by the date in the question', () => {
    const store = newStore();
    const { pg } = seedBoth(store);
    const r = recall(store, 'What did I ask you on 3 November? Is your answer still correct today?', tuesday);

    expect(r.refs[0].label).toBe('Tue 3 Nov 2026');
    expect(r.emptyRefs).toEqual([]);
    const hit = r.hits.find((h) => h.messageId === pg);
    expect(hit?.matchedBy).toContain('date');
    expect(r.firstMemoryAt).toBe('2026-11-03T10:14:00.000Z');
  });

  it('keeps every exchange of a named day when the message names no topic, and only the matching one when it does', () => {
    const store = newStore();
    const { pg } = seedBoth(store);
    const other = store.createConversation(new Date('2026-11-03T16:00:00Z'));
    const bun = seedExchange(store, other.id, '2026-11-03T16:40:00Z', {
      question: 'Is Bun production-ready compared to Node.js now?',
      answer: 'Mostly, for HTTP services and tooling; Node.js still wins on native addons.',
      entities: ['Bun', 'Node.js'],
    });

    const all = recall(store, 'What did I ask you on 3 November?', tuesday).hits.map((h) => h.messageId);
    expect(all).toEqual(expect.arrayContaining([pg, bun]));

    const topical = recall(store, 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?', tuesday);
    expect(topical.hits.map((h) => h.messageId)).toEqual([pg]);
  });

  it('finds the CRM turn by a bare weekday', () => {
    const store = newStore();
    const { crm } = seedBoth(store);
    const r = recall(store, 'On Monday we shortlisted 5 CRM tools... has any of them changed pricing since?', tuesday);

    expect(r.refs[0].label).toBe('Mon 9 Nov 2026');
    const hit = r.hits.find((h) => h.messageId === crm);
    expect(hit?.matchedBy).toContain('date');
    expect(hit?.conversationTitle).toBeNull();
  });

  it('reports a date with no turns as empty and adds no date hits', () => {
    const store = newStore();
    seedBoth(store);
    const r = recall(store, 'What did I ask you on 5 November?', tuesday);

    expect(r.emptyRefs.map((x) => x.label)).toEqual(['Thu 5 Nov 2026']);
    expect(r.hits.some((h) => h.matchedBy.includes('date'))).toBe(false);
  });

  it('finds the Postgres turn by topic when no date is given', () => {
    const store = newStore();
    const { pg } = seedBoth(store);
    const r = recall(store, 'the postgres answer you gave', tuesday);

    expect(r.refs).toEqual([]);
    const hit = r.hits.find((h) => h.messageId === pg);
    expect(hit?.matchedBy).toEqual(['keywords']);
  });

  it('uses the alternate reading of "last Tuesday" when the primary day is empty', () => {
    const store = newStore();
    // Only a Tuesday 3 Nov exchange exists, so "last Tuesday" said on Thursday 12 Nov must fall back to it.
    const conv = store.createConversation();
    const pg = seedExchange(store, conv.id, '2026-11-03T10:14:00Z', {
      question: 'Which hosting should I use for Postgres?',
      answer: 'Neon is a good fit for Postgres.',
    });

    const r = recall(store, 'Last Tuesday I asked you about Postgres hosting', thursday);
    expect(r.refs[0].label).toBe('Tue 3 Nov 2026');
    expect(r.refs[0].alternates).toBeUndefined();
    expect(r.emptyRefs).toEqual([]);
    expect(r.hits.find((h) => h.messageId === pg)?.matchedBy).toContain('date');
  });

  it('excludes the current conversation from keyword hits', () => {
    const store = newStore();
    const { work, pg } = seedBoth(store);
    const r = recall(store, 'the postgres answer you gave', tuesday, { conversationId: work.id });
    expect(r.hits.some((h) => h.messageId === pg)).toBe(false);
  });

  it('marks a turn found by both its date and its keywords', () => {
    const store = newStore();
    const { pg } = seedBoth(store);
    const r = recall(store, 'What did I ask you on 3 November about Postgres?', tuesday);

    const hit = r.hits.find((h) => h.messageId === pg);
    expect(hit?.matchedBy).toEqual(['date', 'keywords']);
    // Found both ways, so it is one hit with both scores added, and it is the top hit.
    expect(r.hits[0].messageId).toBe(pg);
    expect(r.hits.filter((h) => h.messageId === pg)).toHaveLength(1);
  });

  it('lists recent conversations with turns for the memory index', () => {
    const store = newStore();
    const { work, sales } = seedBoth(store);
    const r = recall(store, 'hello there', tuesday);
    expect(r.index.map((c) => c.id)).toEqual([sales.id, work.id]);
    expect(r.index[0].turns).toBe(1);
  });
});

describe('writeMemoryNotes', () => {
  const sources: SourceSummary[] = [
    { n: 3, url: 'https://neon.tech/pricing', title: 'Neon pricing', site: 'neon.tech' },
  ];
  const input = {
    question: 'What does Neon cost?',
    answer: 'The Launch plan is $19/month [3].',
    sources,
    askedAt: '2026-11-03T10:14:00.000Z',
  };

  it('cleans a messy reply and maps claim sources to URLs', async () => {
    const llm = async () => ({
      title: '  Postgres hosting prices  ',
      summary: 'x'.repeat(700),
      topics: ['Postgres Hosting', '', 'postgres hosting', 42, 'Pricing'],
      entities: ['Neon', null],
      claims: [
        { subject: 'Neon', attribute: 'Launch plan price', value: '$19/month', source: 3 },
        { subject: '', attribute: 'Ignored', value: 'no subject' },
        'junk',
        { subject: 'Supabase', attribute: 'Pro price', value: '$25/month', source: 9 },
      ],
    });

    const notes = await writeMemoryNotes({ ...input, needsTitle: true }, llm);
    expect(notes.title).toBe('Postgres hosting prices');
    expect(notes.summary).toHaveLength(600);
    expect(notes.topics).toEqual(['postgres hosting', 'pricing']);
    expect(notes.entities).toEqual(['Neon']);
    expect(notes.claims).toEqual([
      {
        subject: 'Neon',
        attribute: 'Launch plan price',
        value: '$19/month',
        sourceUrl: 'https://neon.tech/pricing',
        asOf: '2026-11-03T10:14:00.000Z',
      },
      { subject: 'Supabase', attribute: 'Pro price', value: '$25/month', asOf: '2026-11-03T10:14:00.000Z' },
    ]);
  });

  it('ignores a title when none was requested', async () => {
    const notes = await writeMemoryNotes({ ...input, needsTitle: false }, async () => ({ title: 'Unasked' }));
    expect(notes.title).toBeUndefined();
  });

  it('falls back to the plain answer when the call throws', async () => {
    const notes = await writeMemoryNotes(
      { ...input, answer: '## Neon\n\nThe **Launch** plan costs $19/month [3].', needsTitle: true },
      async () => {
        throw new Error('offline');
      },
    );
    expect(notes.summary).toContain('Launch plan costs $19/month');
    expect(notes.summary).not.toMatch(/[#*\[]/);
    expect(notes).toMatchObject({ topics: [], entities: [], claims: [] });
    expect(notes.title).toBeUndefined();
  });

  it('processTurn stores the notes and the title, and never throws', async () => {
    const store = newStore();
    const conv = store.createConversation();
    const msg = store.addMessage({ conversationId: conv.id, role: 'assistant', content: 'The Launch plan is $19/month.' });
    const turn: TurnMemory = {
      messageId: msg.id,
      conversationId: conv.id,
      askedAt: msg.createdAt,
      question: 'What does Neon cost?',
      answer: 'The Launch plan is $19/month.',
      summary: null,
      topics: [],
      entities: [],
      claims: [],
      sources: [],
    };

    await processTurn(store, turn, true, async () => ({
      title: 'Neon pricing',
      summary: 'Neon Launch is $19/month.',
      topics: ['pricing'],
      entities: ['Neon'],
      claims: [{ subject: 'Neon', attribute: 'Launch plan price', value: '$19/month' }],
    }));
    expect(store.getConversation(conv.id)?.title).toBe('Neon pricing');
    expect(store.getTurn(msg.id)).toMatchObject({ summary: 'Neon Launch is $19/month.', entities: ['Neon'] });
    expect(store.searchTurns(['neon'])[0].messageId).toBe(msg.id);

    await expect(
      processTurn(store, turn, false, async () => {
        throw new Error('down');
      }),
    ).resolves.toMatchObject({ topics: [] });
  });
});
