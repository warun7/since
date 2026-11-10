# since: design

Every example in the test set is about time: *what did I ask on 3 November, is it still correct, what changed since Monday?* An answer about prices or releases goes stale, so the agent has to know when it said something and exactly what it said, and must be able to check that against today. So `since` stores each answer as a dated record of checkable claims, and treats "now" (in the user's timezone) as an input, not an assumption.

## How a turn works

```
message ─► recall: resolve dates + SQLite lookup (deterministic, ~5 ms)
        ─► CONTEXT: now, calendar, resolved dates, past exchanges + their claims
        ─► DeepSeek step (streamed) ─┬─► answer with [n] citations ─► done
                                     └─► web_search(queries[]) ─► parallel DeepSeek Search
                                         ─► fuse, rank, BM25 passages ─► next step (≤ 3)
after the answer: memory notes in the background (title, summary, claims) · optional upheld check
```

1. **Memory is context, not a tool.** The model has one tool, `web_search`. Before the first token, `chrono-node` and `luxon` turn "last Tuesday", "on Monday" and "3 November" into whole-day ranges in the user's timezone. Ambiguous phrases keep both readings ("last Tuesday" said on a Thursday), and recall uses whichever reading has conversations. SQLite returns the exchanges in those ranges plus FTS5 matches on topic words. The model gets plain data: the exchange with its claims, or "3 November = Tue 3 Nov 2026 — NO conversations on this date". So recall costs no round trip, the model can't skip it, and the model never does date arithmetic, so it can't get it wrong.
2. **Answers become claims.** After an answer streams, a background JSON-mode call records its checkable claims (`Neon · Launch compute: $0.106/CU-hour · source · as of 3 Nov`), plus a title and summary. "Has pricing changed since then?" becomes a diff over stored values. That matters because pricing pages change without a new publication date, which a date-filtered news search alone misses. So the prompt asks for both: the vendor's page with `site`, and news with `after`.
3. **Search that reads.** One call carries up to 8 queries, each with optional `site` and `after`, and they run in parallel against DeepSeek Search (about 0.5–0.9 s each). Results are fused across queries (reciprocal rank fusion plus the provider's rerank and authority scores), deduplicated by canonical URL and capped per site. Every query is guaranteed its own best hit, so one CRM's pages can't crowd out another's. Pages are cut to the BM25-best 110-word windows, about 1,400 characters per source rather than whole pages. Thin official pages are read with DeepSeek Fetch inside the same call.
4. **Citations you can trust.** `[n]` is stable across a conversation. Numbers the model wasn't shown are stripped before saving. With `UPHELD_URL` set, [upheld](https://github.com/warun7/upheld), my citation checker, audits each answer against the exact passages the model saw, after streaming finishes. The UI shows "9/10 supported".
5. **Fast by construction.** Tokens stream from the first step, and there is no planner call. The prompt order (static system prompt → history → per-message CONTEXT → user message) lets DeepSeek's prefix cache cover everything but the newest turn. The model is `deepseek-flash` with thinking off. The UI shows recall, queries and sources as they happen. Measured: a follow-up gives its first token in 0.6–1 s; "no record of that date" takes 1.3–1.8 s in total; a fresh fact 3.3–4 s; a diff against last Tuesday's answer about 7 s; the five-CRM check 7–10 s.

The prompt enforces honesty, and recall gives it the data to be honest with: never invent a past exchange; when a date is empty, say so first, name the nearest dates there are, then still help with the present-tense half; "since <date>" counts only things dated after it.

## Considered and rejected

- **A `recall` tool.** It costs a round trip and the model can skip it. Dates are deterministic, so they're resolved in code.
- **A planner/router call.** It adds 1–2 s to every message. The first streamed step plans the queries or just answers.
- **A memory layer such as mem0.** It is built for durable facts about the user, consolidated over time: a new value updates the old one, and search returns the current version. A then/now diff needs the opposite: an immutable, dated record of what was said, found by date range rather than by similarity. It would also need an embeddings provider (DeepSeek has none) and an embedding call on the hot path. What mem0 does well, a profile of the user, is listed below.
- **Embeddings for memory.** As above, a second key. For one person's history, date ranges, BM25 and the model reading the text are enough.
- **Thinking mode.** It adds seconds before the first token. Resolved dates, stored claims and an explicit then/now procedure replace most of what it would reason out.
- **upheld before showing the answer.** It takes 0.3–3 s per claim, on Python and torch. It belongs after the answer, and in evals.
- **A fetch tool, an agent framework, Next.js.** The brief allows one tool, so reading is folded into search. The loop is about 250 lines; owning it controls parallelism, the step budget, prompt order and the event stream. The UI is one ES module with no build step.

## Evaluation, and what it changed

`npm test`: 74 offline unit tests (dates across timezones, recall precision, ranking, passages, citations, context). `npm run eval`: seven scenarios with fixed clocks and fixture history, judged by an LLM against a rubric, with deterministic search-budget checks and upheld citation support. In the last full run, all 7 scenarios met every behaviour criterion, with a mean of 2.8 s to first token and 4.2 s in total.

upheld found what reading answers didn't. A then/now table row ("| Supabase Pro | $25 | $25 [7] | Unchanged |") mixes a remembered value with a sourced one, so as a "sentence" every row failed. Checking each cited cell as its own claim raised support from 8/35 to 17/28. Most remaining flags are real: a number carried over from the old answer and cited to today's page, or a passage window that missed the figure.

## With another week

- **Profile memory next to episodic memory:** durable facts the user states ("we're 20 people", "we're on AWS", "prices in INR"), extracted in the same background pass and merged in place, which is the part of a mem0-style layer this agent lacks.
- **Proactive change detection:** re-check stored claims on a schedule, and open the next chat with what moved.
- **Tighter grounding for diffs:** require each "Now" value to be quoted from a passage, and tune passage selection on upheld's misses.
- **Repair before showing:** re-search flagged claims, once a faster verifier fits the latency budget.
- **Structured price extraction** from pricing tables; hybrid memory retrieval for long histories; multi-user auth; a larger, human-labelled eval set.
