// A question asked while example history is being added must wait for it. Without the wait,
// recall reads an empty memory and the answer says there is no record of any past conversation.
import { describe, expect, it, vi } from 'vitest';

let releaseSeed: () => void = () => {};
const order: string[] = [];

vi.mock('../src/demo/seed.js', () => ({
  demoSeeds: () => [{}, {}, {}],
  seedDemoHistory: vi.fn(
    () =>
      new Promise((resolve) => {
        releaseSeed = () => {
          order.push('seeded');
          resolve([{}, {}, {}].map((seed) => ({ seed, sources: 3 })));
        };
      }),
  ),
}));

vi.mock('../src/agent/orchestrator.js', () => ({
  runTurn: vi.fn(async (input: { message: string }) => {
    order.push(`turn: ${input.message}`);
    return { conversationId: 'c', content: '', trace: null, notes: Promise.resolve() };
  }),
}));

const { createApi } = await import('../src/app.js');
const { openDb } = await import('../src/memory/db.js');
const { MemoryStore } = await import('../src/memory/store.js');

const post = (body: unknown) => ({
  method: 'POST',
  body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
});

describe('a question during example history', () => {
  it('waits for the history, and says so while it waits', async () => {
    const api = createApi({ store: new MemoryStore(openDb(':memory:')) });
    const seeding = api.request('/api/example-history', post({ tz: 'Europe/London' }));
    const chat = api.request('/api/chat', post({ message: 'What did I ask you on 3 November?' }));

    const res = await chat;
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('Finishing the example history');
    // The turn has not started: the history isn't in memory yet.
    expect(order).toEqual([]);

    releaseSeed();
    expect((await seeding).status).toBe(200);
    while (!(await reader.read()).done);
    expect(order).toEqual(['seeded', 'turn: What did I ask you on 3 November?']);
  });

  it('starts at once when no history is being added', async () => {
    order.length = 0;
    const api = createApi({ store: new MemoryStore(openDb(':memory:')) });
    const res = await api.request('/api/chat', post({ message: 'Hello' }));
    await res.text();
    expect(order).toEqual(['turn: Hello']);
  });
});
