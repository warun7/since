import { describe, expect, it, vi } from 'vitest';
import { chatMessage, createApi } from '../src/app.js';
import { openDb } from '../src/memory/db.js';
import { MemoryStore } from '../src/memory/store.js';

function setup(admit = vi.fn(async () => null as string | null)) {
  const sql = openDb(':memory:');
  const store = new MemoryStore(sql);
  return { sql, store, admit, api: createApi({ store, admit }) };
}

/** One remembered exchange, as the agent leaves it after an answer. */
function remember(store: MemoryStore): void {
  const { id } = store.createConversation();
  const msg = store.addMessage({ conversationId: id, role: 'assistant', content: 'An answer.' });
  store.saveTurn({
    messageId: msg.id,
    conversationId: id,
    askedAt: msg.createdAt,
    question: 'A question?',
    answer: 'An answer.',
    summary: null,
    topics: [],
    entities: [],
    claims: [],
    sources: [],
  });
}

const post = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...headers },
});

describe('API', () => {
  it('charges nothing for a request it turns away', async () => {
    const { api, admit } = setup();
    expect((await api.request('/api/chat', post({}))).status).toBe(400);
    expect((await api.request('/api/chat', post('not json'))).status).toBe(400);
    expect(admit).not.toHaveBeenCalled();
  });

  it('refuses with the reason the meter gives, before anything is stored', async () => {
    const { api, store, admit } = setup(vi.fn(async () => 'No more today.'));
    const res = await api.request('/api/chat', post({ message: 'What does Neon cost?' }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'No more today.' });
    expect(admit).toHaveBeenCalledWith(1, expect.any(Request));
    expect(store.isEmpty()).toBe(true);
  });

  it('charges nothing for example history into a memory that already has some', async () => {
    const { api, store, admit } = setup();
    remember(store);
    expect((await api.request('/api/example-history', post({}))).status).toBe(409);
    expect(admit).not.toHaveBeenCalled();
  });

  it('refuses changes from other sites', async () => {
    const { api } = setup();
    expect((await api.request('/api/chat', post({}, { 'Sec-Fetch-Site': 'cross-site' }))).status).toBe(403);
    expect((await api.request('/api/chat', post({}, { 'Sec-Fetch-Site': 'same-site' }))).status).toBe(403);
    const { 'Sec-Fetch-Site': _, ...noFetchSite } = post({}).headers;
    const fromElsewhere = { ...post({}), headers: { ...noFetchSite, Origin: 'https://evil.example' } };
    expect((await api.request('/api/chat', fromElsewhere)).status).toBe(403);
    expect((await api.request('/api/conversations/x', { method: 'DELETE', headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
    // Reads stay open, and a same-origin change goes through to validation.
    expect((await api.request('/api/conversations', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(200);
    expect((await api.request('/api/chat', post({}))).status).toBe(400);
  });

  it('turns away an oversized body before reading it', async () => {
    const { api, admit } = setup();
    const res = await api.request('/api/chat', post({ message: 'x'.repeat(100_000) }));
    expect(res.status).toBe(413);
    expect(admit).not.toHaveBeenCalled();
  });

  it('forgets everything, search index included, but only when asked from its own pages', async () => {
    const { api, store, sql } = setup();
    remember(store);
    remember(store);
    expect((await api.request('/api/conversations', { method: 'DELETE', headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
    expect(store.isEmpty()).toBe(false);
    expect((await api.request('/api/conversations', { method: 'DELETE', headers: { 'Sec-Fetch-Site': 'same-origin' } })).status).toBe(200);
    expect(store.isEmpty()).toBe(true);
    for (const table of ['turns_fts', 'turns', 'messages', 'sources']) {
      expect(sql.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n).toBe(0);
    }
  });

  it('treats a body that is not an object as a missing message', async () => {
    const { api } = setup();
    for (const body of ['null', '5', '"hi"', '[]']) expect((await api.request('/api/chat', post(body))).status).toBe(400);
    expect(chatMessage({ message: '  ' })).toEqual({ error: 'message is required', status: 400 });
    expect(chatMessage({ message: 'x'.repeat(8001) })).toMatchObject({ status: 413 });
    expect(chatMessage({ message: ' What changed? ' })).toBe('What changed?');
  });

  it('marks API responses as not cacheable', async () => {
    const { api } = setup();
    expect((await api.request('/api/conversations')).headers.get('Cache-Control')).toBe('no-store');
    expect((await api.request('/api/chat', post({}))).headers.get('Cache-Control')).toBe('no-store');
  });
});
