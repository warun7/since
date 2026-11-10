// Example history: three real conversations run through the agent with backdated clocks
// (last Tuesday, last Monday, 3 November), so the memory questions work straight away.
// Used by `npm run seed` and by the UI's "Add example history" button.
import { DateTime } from 'luxon';
import { runTurn } from '../agent/orchestrator.js';
import type { MemoryStore } from '../memory/store.js';

export interface DemoSeed {
  label: string;
  at: Date;
  question: string;
}

export interface SeedResult {
  seed: DemoSeed;
  sources: number;
  error?: string;
}

/** Most recent `weekday` (1 = Mon … 7 = Sun) strictly before `today`, at hour:minute. */
function lastWeekdayBefore(today: DateTime, weekday: number, hour: number, minute: number): DateTime {
  let days = (today.weekday - weekday + 7) % 7;
  if (days === 0) days = 7;
  return today.minus({ days }).set({ hour, minute, second: 0, millisecond: 0 });
}

export function demoSeeds(now: Date, tz: string): DemoSeed[] {
  const local = DateTime.fromJSDate(now).setZone(tz);
  const today = local.startOf('day');
  let nov3 = DateTime.fromObject({ year: local.year, month: 11, day: 3, hour: 16, minute: 40 }, { zone: tz });
  if (nov3 > local) nov3 = nov3.minus({ years: 1 });

  const seeds = [
    {
      label: 'last Tuesday',
      at: lastWeekdayBefore(today, 2, 10, 14),
      question: 'What are the cheapest managed Postgres hosting options right now for a small production app? Compare the entry paid plans.',
    },
    {
      label: 'last Monday',
      at: lastWeekdayBefore(today, 1, 14, 5),
      question: "We're picking a CRM for a 20-person sales team. Shortlist the 5 best options with per-seat pricing.",
    },
    { label: '3 November', at: nov3, question: 'Is Bun production-ready compared to Node.js now?' },
  ];
  return seeds.map((s) => ({ ...s, at: s.at.toJSDate() })).sort((a, b) => a.at.getTime() - b.at.getTime());
}

/**
 * Runs the three seed conversations and waits for their memory notes. They are separate
 * conversations, so they run at once; each recalls before any of them has an answer saved.
 */
export async function seedDemoHistory(store: MemoryStore, opts: { tz: string; now?: Date }): Promise<SeedResult[]> {
  return Promise.all(
    demoSeeds(opts.now ?? new Date(), opts.tz).map(async (seed): Promise<SeedResult> => {
      let sources = 0;
      try {
        const result = await runTurn(
          { message: seed.question, clock: { now: seed.at, tz: opts.tz } },
          (e) => {
            if (e.type === 'done') sources = e.sources.length;
          },
          { store },
        );
        await result.notes;
        return { seed, sources };
      } catch (err) {
        return { seed, sources, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
}
