// LLM grader: scores one final answer against a scenario's rubric, one criterion per line.
import { DateTime } from 'luxon';
import { chatJSON } from '../src/llm/deepseek.js';
import type { SearchQuery } from '../src/types.js';
import type { Scenario } from './scenarios.js';

export interface Criterion {
  criterion: string;
  pass: boolean;
  reason: string;
}

export interface JudgeResult {
  criteria: Criterion[];
  passRate: number;
}

const SYSTEM = `You are a strict grader of answers from a chat assistant with web search and memory of earlier conversations.
You grade one final answer against a rubric. Each rubric line is one criterion.
A criterion passes only when the final answer clearly meets it. If it is ambiguous, fails, or cannot be checked from the material given, it fails.
Use only the material provided: today's date, the earlier conversations, the search queries and the answer. Do not assume facts that are not shown.
Respond with a JSON object only, in exactly this shape:
{"criteria":[{"criterion":"<the rubric line, verbatim>","pass":true,"reason":"<one short sentence>"}]}
Return one entry per rubric line, in the same order as the rubric.`;

interface JudgeInput {
  scenario: Scenario;
  answer: string;
  queries: SearchQuery[][];
  now: string;
  /** Earlier turns of the same conversation (for follow-up scenarios), oldest first. */
  priorTurns?: Array<{ question: string; answer: string }>;
}

function fmtQuery(q: SearchQuery): string {
  const ops = [q.site ? `site:${q.site}` : '', q.after ? `after:${q.after}` : ''].filter(Boolean).join(' ');
  return ops ? `"${q.q}" (${ops})` : `"${q.q}"`;
}

function fmtQueries(queries: SearchQuery[][]): string {
  if (queries.length === 0) return '(no searches were run for this message)';
  return queries.map((qs, i) => `step ${i + 1}: ${qs.map(fmtQuery).join(' | ') || '(none)'}`).join('\n');
}

function fmtWhen(iso: string, tz: string): string {
  const dt = DateTime.fromISO(iso, { zone: tz });
  return dt.isValid ? `${dt.toFormat('ccc d LLL yyyy, HH:mm')} (${tz})` : iso;
}

function fmtHistory(scenario: Scenario): string {
  if (scenario.history.length === 0) return '(none: this user has no earlier conversations in memory)';
  return scenario.history
    .map((t) => {
      const claims = (t.claims ?? []).map((c) => `    - ${c.subject}, ${c.attribute}: ${c.value}`).join('\n');
      return [`- Asked ${fmtWhen(t.askedAt, scenario.tz)}: "${t.question}"`, claims ? `  Claims recorded from that answer:\n${claims}` : ''].filter(Boolean).join('\n');
    })
    .join('\n');
}

function buildUser(input: JudgeInput): string {
  const { scenario, answer, queries, now, priorTurns = [] } = input;
  const today = DateTime.fromISO(now, { zone: scenario.tz });
  const todayLabel = today.isValid ? today.toFormat('cccc d LLLL yyyy, HH:mm') : now;
  const prior = priorTurns.length
    ? `Earlier turns in this conversation:\n${priorTurns.map((t) => `User: ${t.question}\nAssistant: ${t.answer}`).join('\n\n')}\n\n`
    : '';
  const finalMessage = scenario.turns[scenario.turns.length - 1] ?? '';
  const rubric = scenario.rubric.map((r, i) => `${i + 1}. ${r}`).join('\n');
  return [
    `Today: ${todayLabel} (${scenario.tz})`,
    `Scenario: ${scenario.description}`,
    '',
    `Earlier conversations in memory:\n${fmtHistory(scenario)}`,
    '',
    `${prior}Final user message:\n${finalMessage}`,
    '',
    `Search queries the assistant ran for the final message:\n${fmtQueries(queries)}`,
    '',
    `Assistant's final answer (to grade):\n"""\n${answer}\n"""`,
    '',
    `Rubric (one criterion per line):\n${rubric}`,
  ].join('\n');
}

type RawCriterion = { criterion?: unknown; pass?: unknown; reason?: unknown };

/**
 * Grades `answer` against every rubric line. Always returns one criterion per rubric line.
 * If the grader call or its JSON fails, every criterion fails with the error as its reason.
 */
export async function judge(input: JudgeInput): Promise<JudgeResult> {
  const rubric = input.scenario.rubric;
  const fail = (reason: string): JudgeResult => ({
    criteria: rubric.map((criterion) => ({ criterion, pass: false, reason })),
    passRate: 0,
  });
  let raw: RawCriterion[];
  try {
    const parsed = await chatJSON<{ criteria?: unknown }>(SYSTEM, buildUser(input), { maxTokens: 3000 });
    if (!parsed || !Array.isArray(parsed.criteria)) throw new Error('response had no "criteria" array');
    raw = parsed.criteria as RawCriterion[];
  } catch (err) {
    return fail(`judge error: ${err instanceof Error ? err.message : String(err)}`);
  }

  const norm = (s: string) => s.trim().toLowerCase();
  const criteria: Criterion[] = rubric.map((criterion, i) => {
    const entry = raw.find((r) => typeof r.criterion === 'string' && norm(r.criterion) === norm(criterion)) ?? raw[i];
    if (!entry) return { criterion, pass: false, reason: 'judge did not grade this criterion' };
    return {
      criterion,
      pass: entry.pass === true,
      reason: typeof entry.reason === 'string' ? entry.reason : String(entry.reason ?? ''),
    };
  });
  const passed = criteria.filter((c) => c.pass).length;
  return { criteria, passRate: rubric.length ? passed / rubric.length : 1 };
}
