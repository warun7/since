// Seeds example history by running real turns with backdated clocks, so the memory
// questions work straight away. Usage: npm run seed [-- --reset]
//   --reset  delete the database first (data/since.db, -wal and -shm).
// The UI's "Add example history" button does the same for an empty memory.
import 'dotenv/config';
import { rmSync } from 'node:fs';
import { assertConfig, config } from '../src/config.js';
import { seedDemoHistory } from '../src/demo/seed.js';
import { openStore } from '../src/memory/db.js';
import { formatDay } from '../src/memory/temporal.js';

async function main(): Promise<void> {
  assertConfig();
  const reset = process.argv.includes('--reset');
  const tz = config.defaultTz;

  if (reset) {
    for (const file of [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`]) rmSync(file, { force: true });
    console.log(`reset: removed ${config.dbPath}`);
  }

  const store = openStore(config.dbPath);
  if (!reset && store.listConversations(1).length > 0) {
    console.log(`note: ${config.dbPath} already has conversations. Seeding adds three more (use --reset to start fresh).`);
  }

  const results = await seedDemoHistory(store, { tz });
  for (const { seed, sources, error } of results) {
    const day = `${formatDay(seed.at.toISOString(), tz)} (${seed.label})`;
    if (error) console.error(`  failed ${day}: ${error}`);
    else console.log(`  ${day}  "${seed.question}"  ${sources} source${sources === 1 ? '' : 's'}`);
  }

  const failures = results.filter((r) => r.error).length;
  console.log(failures ? `\n${failures} seeded exchange(s) failed.` : `\nseeded 3 exchanges in ${config.dbPath}. Try: npm run chat`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
