// Sets eval runs side by side, pooled by thinking effort: the ablation behind the effort default.
// Usage: npx tsx evals/compare.ts evals/results/<runA> evals/results/<runB> [...]
// Each run is one arm. Runs with the same effort are pooled, so two runs an arm give twice the turns.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Trace {
  timings: { firstActivityMs?: number | null; firstTokenMs: number | null; totalMs: number; thinkingMs?: number };
  usage: { reasoningTokens?: number; completionTokens: number };
  searchRounds?: number;
}
interface Report {
  runId: string;
  effort?: string;
  scenarios: Array<{
    id: string;
    judgePassRate: number;
    expect: { ok: boolean };
    turns: Array<{ answer: string; trace: Trace | null }>;
    grounding: { supported: number; cited: number } | null;
  }>;
}

const dirs = process.argv.slice(2);
if (!dirs.length) {
  console.error('usage: npx tsx evals/compare.ts evals/results/<run> [...]');
  process.exit(1);
}
const reports = dirs.map((d) => JSON.parse(readFileSync(join(d, 'report.json'), 'utf8')) as Report);
const arms = new Map<string, Report[]>();
for (const r of reports) arms.set(r.effort ?? 'off', [...(arms.get(r.effort ?? 'off') ?? []), r]);

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pctl = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]! : NaN;
};
const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
const s = (ms: number) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(2)} s` : '-');
const pc = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '-');

const rows: Array<[string, (rs: Report[]) => string]> = [
  ['runs', (rs) => String(rs.length)],
  ['judge score', (rs) => pc(avg(rs.flatMap((r) => r.scenarios.map((x) => x.judgePassRate))))],
  ['behaviour checks', (rs) => { const all = rs.flatMap((r) => r.scenarios); return `${all.filter((x) => x.expect.ok).length}/${all.length}`; }],
  ...(['p50', 'p95'] as const).flatMap((p): Array<[string, (rs: Report[]) => string]> => [
    [`first activity ${p}`, (rs) => s(pctl(traces(rs).map((t) => t.timings.firstActivityMs).filter((x): x is number => x != null), p === 'p50' ? 50 : 95))],
    [`first token ${p}`, (rs) => s(pctl(traces(rs).map((t) => t.timings.firstTokenMs).filter((x): x is number => x != null), p === 'p50' ? 50 : 95))],
    [`total ${p}`, (rs) => s(pctl(traces(rs).map((t) => t.timings.totalMs), p === 'p50' ? 50 : 95))],
  ]),
  ['reasoning tokens a turn', (rs) => String(Math.round(avg(traces(rs).map((t) => t.usage.reasoningTokens ?? 0))))],
  ['thinking a turn', (rs) => s(avg(traces(rs).map((t) => t.timings.thinkingMs ?? 0)))],
  ['search rounds a turn', (rs) => avg(traces(rs).map((t) => t.searchRounds ?? 0)).toFixed(2)],
  ['words a final answer', (rs) => String(Math.round(avg(rs.flatMap((r) => r.scenarios.map((x) => words(x.turns.at(-1)?.answer ?? '')))))) ],
  ['grounding flags', (rs) => { const g = rs.flatMap((r) => r.scenarios.map((x) => x.grounding).filter((x) => !!x)); const c = g.reduce((a, x) => a + x!.cited, 0); const ok = g.reduce((a, x) => a + x!.supported, 0); return c ? `${c - ok}/${c} (${pc((c - ok) / c)})` : '-'; }],
];
function traces(rs: Report[]): Trace[] {
  return rs.flatMap((r) => r.scenarios.flatMap((x) => x.turns.map((t) => t.trace))).filter((t): t is Trace => !!t);
}

const names = [...arms.keys()];
const w = 26;
const cell = (x: string, n = 16) => x.padEnd(n);
console.log(cell('', w) + names.map((n) => cell(`thinking ${n}`)).join(''));
for (const [label, f] of rows) console.log(cell(label, w) + names.map((n) => cell(f(arms.get(n)!))).join(''));

console.log(`\n${cell('judge by scenario', w)}${names.map((n) => cell(n)).join('')}`);
const ids = [...new Set(reports.flatMap((r) => r.scenarios.map((x) => x.id)))];
for (const id of ids) {
  console.log(
    cell(id, w) +
      names.map((n) => cell(arms.get(n)!.map((r) => { const x = r.scenarios.find((y) => y.id === id); return x ? pc(x.judgePassRate) : '-'; }).join(' '))).join(''),
  );
}
