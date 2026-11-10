// Seeds believable demo history by running real turns with backdated clocks, so the memory
// questions work straight away. Usage: npm run seed [-- --reset]
//   --reset  delete the database first (data/since.db, -wal and -shm).
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { DateTime } from 'luxon';
import { assertConfig, config } from '../src/config.js';
import { flushBackground, runTurn } from '../src/agent/orchestrator.js';
import { MemoryStore } from '../src/memory/store.js';
import { formatDay } from '../src/memory/temporal.js';
import type { AgentEvent } from '../src/types.js';

interface Seed {
  label: string;
  at: DateTime;
  question: string;
}

/** Most recent `weekday` (1 = Mon … 7 = Sun) strictly before `today`, at hour:minute. */
function lastWeekdayBefore(today: DateTime, weekday: number, hour: number, minute: number): DateTime {
  let days = (today.weekday - weekday + 7) % 7;
  if (days === 0) days = 7;
  return today.minus({ days }).set({ hour, minute, second: 0, millisecond: 0 });
}

function buildSeeds(tz: string): Seed[] {
  const now = DateTime.now().setZone(tz);
  const today = now.startOf('day');

  const lastTuesday = lastWeekdayBefore(today, 2, 10, 14);
  const lastMonday = lastWeekdayBefore(today, 1, 14, 5);

  let nov3 = DateTime.fromObject({ year: now.year, month: 11, day: 3, hour: 16, minute: 40 }, { zone: tz });
  if (nov3.toMillis() > now.toMillis()) nov3 = nov3.minus({ years: 1 });

  const seeds: Seed[] = [
    {
      label: 'last Tuesday',
      at: lastTuesday,
      question: 'What are the cheapest managed Postgres hosting options right now for a small production app? Compare the entry paid plans.',
    },
    {
      label: 'last Monday',
      at: lastMonday,
      question: "We're picking a CRM for a 20-person sales team. Shortlist the 5 best options with per-seat pricing.",
    },
    {
      label: '3 November',
      at: nov3,
      question: 'Is Bun production-ready compared to Node.js now?',
    },
  ];
  return seeds.sort((a, b) => a.at.toMillis() - b.at.toMillis());
}

async function main(): Promise<void> {
  assertConfig();
  const reset = process.argv.includes('--reset');
  const tz = config.defaultTz;

  if (reset) {
    for (const file of [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`]) rmSync(file, { force: true });
    console.log(`reset: removed ${config.dbPath}`);
  }
  mkdirSync(dirname(config.dbPath), { recursive: true });

  const store = MemoryStore.open(config.dbPath);
  if (!reset && store.listConversations(1).length > 0) {
    console.log(`note: ${config.dbPath} already has conversations. Seeding adds three more (use --reset to start fresh).`);
  }

  let failures = 0;
  for (const seed of buildSeeds(tz)) {
    const iso = seed.at.toJSDate().toISOString();
    let sources = 0;
    try {
      await runTurn(
        { message: seed.question, clock: { now: seed.at.toJSDate(), tz } },
        (e: AgentEvent) => {
          if (e.type === 'done') sources = e.sources.length;
        },
        { store },
      );
      await flushBackground();
      console.log(`  ${formatDay(iso, tz)} (${seed.label})  "${seed.question}"  ${sources} source${sources === 1 ? '' : 's'}`);
    } catch (err) {
      failures++;
      console.error(`  failed ${seed.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(failures ? `\n${failures} seeded exchange(s) failed.` : `\nseeded 3 exchanges in ${config.dbPath}. Try: npm run chat`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
