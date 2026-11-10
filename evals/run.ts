// Runs the eval scenarios end to end: fixture history -> live turns -> judge, grounding check (+ upheld).
// Usage: npm run eval [-- --only recall-by-date,crm-shortlist]
// Writes evals/results/<runId>/ with one SQLite DB per scenario and report.json.
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertConfig, config } from '../src/config.js';
import { flushBackground, runTurn } from '../src/agent/orchestrator.js';
import { openStore } from '../src/memory/db.js';
import type { MemoryStore } from '../src/memory/store.js';
import { judge, type Criterion } from './judge.js';
import { scenarios, type FixtureTurn, type Scenario } from './scenarios.js';
import { groundAnswer } from '../src/verify/grounding.js';
import { upheldEnabled, verifyAnswer } from '../src/verify/upheld.js';
import { probeGrounding, type GroundingProbe } from './grounding-probe.js';
import type { Claim, Source, SourceSummary, SearchQuery, TurnTrace, Verification } from '../src/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));

interface TurnRecord {
  question: string;
  answer: string;
  conversationId: string | null;
  /** Search queries per step, from the search events. */
  queries: SearchQuery[][];
  sources: SourceSummary[];
  trace: TurnTrace | null;
  errors: string[];
  wallMs: number;
}

interface ScenarioRecord {
  id: string;
  description: string;
  now: string;
  tz: string;
  turns: TurnRecord[];
  /** Search steps in the final turn. */
  searchSteps: number;
  expect: { ok: boolean; detail: string };
  criteria: Criterion[];
  judgePassRate: number;
  /** The model-free grounding check on the final answer, and how often it caught a planted wrong figure. */
  grounding: Verification | null;
  groundingProbe: GroundingProbe | null;
  upheld: Verification | null;
  error?: string;
}

const toSummary = (s: Source): SourceSummary => ({ n: s.n, url: s.url, title: s.title, site: s.site, published: s.published });

/** Writes one fixture conversation: user question, assistant answer with its sources, and the memory note. */
function seedHistory(store: MemoryStore, history: FixtureTurn[]): void {
  for (const t of history) {
    const askedAt = new Date(t.askedAt);
    const conv = store.createConversation(askedAt);
    if (t.title) store.setTitle(conv.id, t.title);
    store.addMessage({ conversationId: conv.id, role: 'user', content: t.question, createdAt: askedAt });

    const sources: Source[] = (t.sources ?? []).map((s) => ({ n: s.n, url: s.url, title: s.title, site: s.site, passages: [] }));
    const assistant = store.addMessage({
      conversationId: conv.id,
      role: 'assistant',
      content: t.answer,
      createdAt: new Date(askedAt.getTime() + 20_000),
      sources: sources.map(toSummary),
    });
    store.saveSources(conv.id, sources);

    const claims: Claim[] = (t.claims ?? []).map((c) => ({
      subject: c.subject,
      attribute: c.attribute,
      value: c.value,
      sourceUrl: c.sourceUrl,
      asOf: t.askedAt,
    }));
    store.saveTurn({
      messageId: assistant.id,
      conversationId: conv.id,
      askedAt: t.askedAt,
      question: t.question,
      answer: t.answer,
      summary: null,
      topics: t.topics ?? [],
      entities: t.entities ?? [],
      claims,
      sources: sources.map(toSummary),
    });
  }
}

function checkExpect(sc: Scenario, searchSteps: number): { ok: boolean; detail: string } {
  const problems: string[] = [];
  const max = sc.expect?.maxSearchSteps;
  const min = sc.expect?.minSearchSteps;
  if (max !== undefined && searchSteps > max) problems.push(`searches ${searchSteps} > max ${max}`);
  if (min !== undefined && searchSteps < min) problems.push(`searches ${searchSteps} < min ${min}`);
  const constraint = [max !== undefined ? `max ${max}` : '', min !== undefined ? `min ${min}` : ''].filter(Boolean).join(', ');
  return {
    ok: problems.length === 0,
    detail: problems.length ? problems.join('; ') : constraint ? `searches ${searchSteps} (${constraint})` : 'no search constraint',
  };
}

async function runScenario(sc: Scenario, runDir: string): Promise<ScenarioRecord> {
  const record: ScenarioRecord = {
    id: sc.id,
    description: sc.description,
    now: sc.now,
    tz: sc.tz,
    turns: [],
    searchSteps: 0,
    expect: { ok: true, detail: '' },
    criteria: [],
    judgePassRate: 0,
    grounding: null,
    groundingProbe: null,
    upheld: null,
  };
  const store = openStore(join(runDir, `${sc.id}.db`));
  let conversationId: string | undefined;

  try {
    seedHistory(store, sc.history);

    for (let i = 0; i < sc.turns.length; i++) {
      const message = sc.turns[i]!;
      // One minute per turn, so a follow-up is later than the turn before it.
      const now = new Date(Date.parse(sc.now) + i * 60_000);
      const turn: TurnRecord = {
        question: message,
        answer: '',
        conversationId: null,
        queries: [],
        sources: [],
        trace: null,
        errors: [],
        wallMs: 0,
      };
      const started = Date.now();
      try {
        const result = await runTurn(
          { conversationId, message, clock: { now, tz: sc.tz } },
          (e) => {
            if (e.type === 'search') turn.queries.push(e.queries);
            else if (e.type === 'done') turn.sources = e.sources;
            else if (e.type === 'error') turn.errors.push(e.message);
          },
          { store },
        );
        conversationId = result.conversationId;
        turn.conversationId = result.conversationId;
        turn.answer = result.content;
        turn.trace = result.trace;
      } catch (err) {
        turn.errors.push(err instanceof Error ? err.message : String(err));
      }
      turn.wallMs = Date.now() - started;
      record.turns.push(turn);
    }

    await flushBackground();

    const last = record.turns[record.turns.length - 1];
    if (!last) throw new Error('scenario has no turns');
    record.searchSteps = last.queries.length;
    record.expect = checkExpect(sc, record.searchSteps);

    const priorTurns = record.turns.slice(0, -1).map((t) => ({ question: t.question, answer: t.answer }));
    const verdict = await judge({ scenario: sc, answer: last.answer, queries: last.queries, now: sc.now, priorTurns });
    record.criteria = verdict.criteria;
    record.judgePassRate = verdict.passRate;

    if (last.conversationId && last.answer && last.sources.length) {
      const cited = new Set(last.sources.map((s) => s.n));
      const stored = store.getSources(last.conversationId).filter((s) => cited.has(s.n));
      const check = { question: last.question, answer: last.answer, sources: stored };
      record.grounding = groundAnswer(check);
      record.groundingProbe = probeGrounding(check);
      if (upheldEnabled()) record.upheld = await verifyAnswer(check);
    }
  } catch (err) {
    record.error = err instanceof Error ? err.message : String(err);
    record.criteria = sc.rubric.map((criterion) => ({ criterion, pass: false, reason: `scenario error: ${record.error}` }));
    record.judgePassRate = 0;
  }
  return record;
}

const secs = (ms: number | null | undefined) => (typeof ms === 'number' ? (ms / 1000).toFixed(2) : '-');
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
/** Nearest-rank percentile: p50 of 15 values is the 8th smallest, p95 the 15th. */
const percentile = (xs: number[], p: number): number | null => {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
};
const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const pct = (x: number) => `${Math.round(x * 100)}%`;

function printTable(records: ScenarioRecord[]): void {
  const header = ['id', 'judge', 'expect', 'searches', 'first tok s', 'total s', 'think s', 'reason tok', 'words', 'grounded', 'upheld S/C'];
  const widths = [26, 7, 8, 9, 12, 9, 8, 11, 6, 9, 11];
  const line = (cells: string[]) => cells.map((c, i) => pad(c, widths[i]!)).join(' ');
  console.log('\n' + line(header));
  console.log(widths.map((w) => '-'.repeat(w)).join(' '));
  for (const r of records) {
    const lastTurn = r.turns[r.turns.length - 1];
    const up = r.upheld
      ? r.upheld.status === 'ok'
        ? `${r.upheld.supported}/${r.upheld.cited}`
        : r.upheld.status
      : '-';
    console.log(
      line([
        r.id + (r.error ? ' (error)' : ''),
        pct(r.judgePassRate),
        r.expect.ok ? 'ok' : 'FAIL',
        String(r.searchSteps),
        secs(lastTurn?.trace?.timings.firstTokenMs),
        secs(lastTurn?.trace?.timings.totalMs),
        secs(lastTurn?.trace?.timings.thinkingMs),
        String(lastTurn?.trace?.usage.reasoningTokens ?? 0),
        String(words(lastTurn?.answer ?? '')),
        r.grounding ? `${r.grounding.supported}/${r.grounding.cited}` : '-',
        up,
      ]),
    );
  }
}

function summarise(records: ScenarioRecord[]) {
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const lastTraces = records.map((r) => r.turns[r.turns.length - 1]?.trace).filter((t): t is TurnTrace => !!t);
  const firstTokens = lastTraces.map((t) => t.timings.firstTokenMs).filter((x): x is number => typeof x === 'number');
  const upheldRuns = records.map((r) => r.upheld).filter((u): u is Verification => !!u && u.status === 'ok');
  const groundingRuns = records.map((r) => r.grounding).filter((g): g is Verification => !!g);
  const probes = records.map((r) => r.groundingProbe).filter((p): p is GroundingProbe => !!p);
  const total = <T>(xs: T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);
  // Latency and thinking are read over every turn, follow-ups included: a follow-up is where
  // thinking can add a search the first turn didn't need.
  const allTraces = records.flatMap((r) => r.turns.map((t) => t.trace)).filter((t): t is TurnTrace => !!t);
  const allFirst = allTraces.map((t) => t.timings.firstTokenMs).filter((x): x is number => typeof x === 'number');
  const allTotal = allTraces.map((t) => t.timings.totalMs);
  const grounded = total(groundingRuns, (g) => g.supported);
  const cited = total(groundingRuns, (g) => g.cited);
  return {
    scenarios: records.length,
    avgJudgePassRate: avg(records.map((r) => r.judgePassRate)),
    expectPassed: records.filter((r) => r.expect.ok).length,
    avgFirstTokenMs: avg(firstTokens),
    avgTotalMs: avg(lastTraces.map((t) => t.timings.totalMs)),
    turns: {
      count: allTraces.length,
      firstTokenMs: { p50: percentile(allFirst, 50), p95: percentile(allFirst, 95) },
      totalMs: { p50: percentile(allTotal, 50), p95: percentile(allTotal, 95) },
      avgReasoningTokens: avg(allTraces.map((t) => t.usage.reasoningTokens ?? 0)),
      avgThinkingMs: avg(allTraces.map((t) => t.timings.thinkingMs ?? 0)),
      avgSearchRounds: avg(allTraces.map((t) => t.searchRounds ?? 0)),
    },
    avgAnswerWords: avg(records.map((r) => words(r.turns.at(-1)?.answer ?? ''))),
    /** Cited claims with a figure that the grounding check could not find on the cited page. */
    groundingFlagRate: cited ? (cited - grounded) / cited : null,
    grounding: groundingRuns.length
      ? {
          grounded,
          cited,
          plantedCaught: total(probes, (p) => p.caught),
          plantedTried: total(probes, (p) => p.tried),
          plantedPricesCaught: total(probes, (p) => p.pricesCaught),
          plantedPricesTried: total(probes, (p) => p.pricesTried),
        }
      : null,
    upheld: upheldRuns.length
      ? { supported: total(upheldRuns, (u) => u.supported), cited: total(upheldRuns, (u) => u.cited) }
      : null,
  };
}

async function main(): Promise<void> {
  assertConfig();

  const onlyArg = process.argv.find((a) => a.startsWith('--only'));
  const onlyValue = !onlyArg
    ? undefined
    : onlyArg.includes('=')
      ? onlyArg.split('=')[1]
      : process.argv[process.argv.indexOf('--only') + 1];
  const only = onlyValue && !onlyValue.startsWith('--') ? new Set(onlyValue.split(',').map((s) => s.trim()).filter(Boolean)) : null;

  const known = new Set(scenarios.map((s) => s.id));
  const unknown = [...(only ?? [])].filter((id) => !known.has(id));
  if (unknown.length) {
    console.error(`unknown scenario(s): ${unknown.join(', ')}. Known: ${[...known].join(', ')}`);
    process.exit(1);
  }
  const selected = only ? scenarios.filter((s) => only.has(s.id)) : scenarios;

  // The effort is in the run id, so two arms started in the same second don't share a folder.
  const runId = `${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}-${config.reasoningEffort}`;
  const runDir = join(HERE, 'results', runId);
  mkdirSync(runDir, { recursive: true });
  console.log(`run ${runId}: ${selected.length} scenario(s), model ${config.chatModel}, thinking ${config.reasoningEffort}, upheld ${upheldEnabled() ? 'on' : 'off'}`);

  const records: ScenarioRecord[] = [];
  for (const sc of selected) {
    console.log(`running ${sc.id}...`);
    records.push(await runScenario(sc, runDir));
  }

  printTable(records);
  const summary = summarise(records);
  console.log(
    `\naverages: judge ${summary.avgJudgePassRate === null ? '-' : pct(summary.avgJudgePassRate)} · expect ${summary.expectPassed}/${summary.scenarios} · ` +
      `first token ${summary.avgFirstTokenMs === null ? '-' : (summary.avgFirstTokenMs / 1000).toFixed(2) + ' s'} · ` +
      `total ${summary.avgTotalMs === null ? '-' : (summary.avgTotalMs / 1000).toFixed(2) + ' s'}` +
      (summary.grounding
        ? ` · grounding ${summary.grounding.grounded}/${summary.grounding.cited} claims grounded, ` +
          `${summary.grounding.plantedCaught}/${summary.grounding.plantedTried} planted wrong figures caught ` +
          `(${summary.grounding.plantedPricesCaught}/${summary.grounding.plantedPricesTried} prices and percentages)`
        : '') +
      (summary.upheld ? ` · upheld ${summary.upheld.supported}/${summary.upheld.cited} cited claims supported` : ''),
  );
  const t = summary.turns;
  console.log(
    `over ${t.count} turns: first token p50 ${secs(t.firstTokenMs.p50)} s, p95 ${secs(t.firstTokenMs.p95)} s · ` +
      `total p50 ${secs(t.totalMs.p50)} s, p95 ${secs(t.totalMs.p95)} s · ` +
      `${Math.round(t.avgReasoningTokens ?? 0)} reasoning tokens and ${secs(t.avgThinkingMs)} s thinking a turn · ` +
      `${(t.avgSearchRounds ?? 0).toFixed(2)} search rounds a turn · ${Math.round(summary.avgAnswerWords ?? 0)} words a final answer` +
      (summary.groundingFlagRate === null ? '' : ` · grounding flags ${pct(summary.groundingFlagRate)} of cited figures`),
  );

  const reportPath = join(runDir, 'report.json');
  writeFileSync(
    reportPath,
    JSON.stringify({ runId, model: config.chatModel, effort: config.reasoningEffort, upheld: upheldEnabled(), summary, scenarios: records }, null, 2),
  );
  console.log(`\nreport: ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
