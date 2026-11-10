// Runs the eval scenarios end to end: fixture history -> live turns -> judge (+ upheld).
// Usage: npm run eval [-- --only recall-by-date,crm-shortlist]
// Writes evals/results/<runId>/ with one SQLite DB per scenario and report.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertConfig, config } from '../src/config.js';
import { flushBackground, runTurn } from '../src/agent/orchestrator.js';
import { MemoryStore } from '../src/memory/store.js';
import { judge, type Criterion } from './judge.js';
import { scenarios, type FixtureTurn, type Scenario } from './scenarios.js';
import { upheldEnabled, verifyAnswer } from '../src/verify/upheld.js';
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
    upheld: null,
  };
  const store = MemoryStore.open(join(runDir, `${sc.id}.db`));
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

    if (upheldEnabled() && last.conversationId && last.answer) {
      const cited = new Set(last.sources.map((s) => s.n));
      const stored = store.getSources(last.conversationId).filter((s) => cited.has(s.n));
      record.upheld = await verifyAnswer({ question: last.question, answer: last.answer, sources: stored });
    }
  } catch (err) {
    record.error = err instanceof Error ? err.message : String(err);
    record.criteria = sc.rubric.map((criterion) => ({ criterion, pass: false, reason: `scenario error: ${record.error}` }));
    record.judgePassRate = 0;
  }
  return record;
}

const secs = (ms: number | null | undefined) => (typeof ms === 'number' ? (ms / 1000).toFixed(2) : '-');
const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const pct = (x: number) => `${Math.round(x * 100)}%`;

function printTable(records: ScenarioRecord[]): void {
  const header = ['id', 'judge', 'expect', 'searches', 'first tok s', 'total s', 'upheld S/C'];
  const widths = [24, 7, 8, 9, 12, 9, 11];
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
  return {
    scenarios: records.length,
    avgJudgePassRate: avg(records.map((r) => r.judgePassRate)),
    expectPassed: records.filter((r) => r.expect.ok).length,
    avgFirstTokenMs: avg(firstTokens),
    avgTotalMs: avg(lastTraces.map((t) => t.timings.totalMs)),
    upheld: upheldRuns.length
      ? { supported: upheldRuns.reduce((a, u) => a + u.supported, 0), cited: upheldRuns.reduce((a, u) => a + u.cited, 0) }
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

  const runId = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const runDir = join(HERE, 'results', runId);
  mkdirSync(runDir, { recursive: true });
  console.log(`run ${runId}: ${selected.length} scenario(s), model ${config.chatModel}, upheld ${upheldEnabled() ? 'on' : 'off'}`);

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
      (summary.upheld ? ` · upheld ${summary.upheld.supported}/${summary.upheld.cited} cited claims supported` : ''),
  );

  const reportPath = join(runDir, 'report.json');
  writeFileSync(
    reportPath,
    JSON.stringify({ runId, model: config.chatModel, upheld: upheldEnabled(), summary, scenarios: records }, null, 2),
  );
  console.log(`\nreport: ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
