// Re-scores the grounding check on a saved eval run, from its per-scenario databases. The check
// is deterministic and needs no model, so a change to it can be measured without new answers.
// Usage: npx tsx evals/regrade-grounding.ts evals/results/<runId>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '../src/memory/db.js';
import { groundAnswer } from '../src/verify/grounding.js';
import { probeGrounding } from './grounding-probe.js';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: npx tsx evals/regrade-grounding.ts evals/results/<runId>');
  process.exit(1);
}
const path = join(dir, 'report.json');
const report = JSON.parse(readFileSync(path, 'utf8'));
const totals = { grounded: 0, cited: 0, plantedCaught: 0, plantedTried: 0, plantedPricesCaught: 0, plantedPricesTried: 0 };

for (const sc of report.scenarios) {
  const last = sc.turns?.at(-1);
  if (!last?.conversationId || !last.answer || !last.sources?.length) continue;
  const cited = new Set(last.sources.map((s: { n: number }) => s.n));
  const sources = openStore(join(dir, `${sc.id}.db`)).getSources(last.conversationId).filter((s) => cited.has(s.n));
  const check = { question: last.question, answer: last.answer, sources };
  sc.grounding = groundAnswer(check);
  sc.groundingProbe = probeGrounding(check);
  totals.grounded += sc.grounding.supported;
  totals.cited += sc.grounding.cited;
  totals.plantedCaught += sc.groundingProbe.caught;
  totals.plantedTried += sc.groundingProbe.tried;
  totals.plantedPricesCaught += sc.groundingProbe.pricesCaught;
  totals.plantedPricesTried += sc.groundingProbe.pricesTried;
  console.log(`${sc.id}: ${sc.grounding.supported}/${sc.grounding.cited} grounded, planted ${sc.groundingProbe.caught}/${sc.groundingProbe.tried} caught`);
}
report.summary.grounding = totals;
writeFileSync(path, JSON.stringify(report, null, 2));
console.log(
  `grounding ${totals.grounded}/${totals.cited} claims grounded, ${totals.plantedCaught}/${totals.plantedTried} planted wrong figures caught ` +
    `(${totals.plantedPricesCaught}/${totals.plantedPricesTried} prices and percentages)`,
);
