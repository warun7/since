# since: design

Every example question is about time: what did I ask on 3 November, is it still right, what changed since Monday? `since` saves each answer as a dated list of claims and checks them against today in the user's timezone.

## How a turn works

```
message ─► recall: resolve the dates, look them up in SQLite (~5 ms, no LLM)
        ─► CONTEXT: today, the resolved dates, past exchanges and their claims
        ─► DeepSeek (streamed) ─┬─► answer with [n] citations
                                └─► web_search(queries[]) ─► DeepSeek Search, in parallel
                                    ─► merge, rank, keep the best passages ─► model again (≤ 3 rounds)
then: grounding check (or upheld) on the citations · in the background: save title, summary and claims
```

1. **Memory is context, not a tool.** The model's only tool is `web_search`. Before it runs, code resolves "last Tuesday" or "3 November" to a date range in the user's timezone and loads those conversations plus keyword matches; an ambiguous phrase tries both dates. No extra call, and the model never does date maths.

2. **Answers are saved as claims.** A background call after each answer saves its checkable claims (`Neon · Launch price: $0.106/CU-hour · source · as of 3 Nov`), so "has pricing changed?" is a comparison of saved values with today's. Pricing pages change without a new date, so the prompt asks for the vendor's page (`site`) and for news since the date (`after`).

3. **Search that reads the page.** One call runs up to 8 queries in parallel; results are merged (reciprocal rank fusion plus DeepSeek's scores), deduplicated, capped per site, and each query keeps its best result so one vendor can't crowd out the rest. Pages are cut to the matching passages (about 1,400 characters), and thin official pages are fetched in full.

4. **Citations you can check.** `[n]` numbers stay fixed across a conversation, and numbers the model wasn't shown are removed. Every answer gets a grounding check: each figure in a cited claim must appear in the passages of the source it cites, or be a sum of them it can redo (15 seats × $10 = $150). No model, milliseconds, so it runs on the hosted demo too; it can't catch a misread figure that is on the page. With `UPHELD_URL` set, [upheld](https://github.com/warun7/upheld) replaces it with a model-based check.

5. **The model sizes its own thinking.** No planner, no router. At low effort it decides from what the question means, not how it is worded: roughly 100 reasoning tokens for an easy question, 2,000 for capacity maths. A search question shows `Thinking…` at 1 s, searches at 2 s, and streams its answer at 5–10 s; an easy one answers in about a second. The system prompt is static and first, so DeepSeek's prompt cache covers everything but the new message.

The prompt also enforces honesty: never invent a past conversation, say first when a date has no record, count only things dated after "since <date>".

**Hosted the same way.** A synchronous `Sql` interface: SQLite locally, a Durable Object per visitor on Cloudflare. Shared store, schema and API; a Worker in front sets the cookie and meters questions per visitor, per network and site-wide. upheld stays local: it needs its own models.

**Cost and scale.** A searching answer spends about 0.6¢ on the Search API (a median of eight queries at $0.75 per 1,000) and 0.07¢ on reasoning, which is why a step is capped at 8 queries and a turn at 3 rounds; 500 questions a day bound the bill. One DeepSeek key covers model and search, and the model client speaks the OpenAI API, so the model is a config change while the search is not. At a hundred times the traffic the first bottleneck is the single Budget Durable Object that meters every question, then the per-isolate query cache, then cold starts — none of which needs a change to the agent loop.

## Considered and rejected

- **A recall tool.** An extra round trip, and the model can forget to call it. Dates resolve in code.
- **A planner call.** 1–2 s on every message, and the first `web_search` call already is one.
- **mem0 or Supermemory.** They return the latest version of a fact about the user; these questions need the exact words of a past answer, found by date. Each adds a key and a call per message, as would embeddings (DeepSeek has none).
- **Thinking off, or effort per question.** Off is 4.6 s faster to the first token (p50) but gets multi-step maths wrong in both eval runs (`evals/effort/`). At low nothing failed for lack of thinking, so a router or `high` would only add latency.
- **upheld before showing the answer.** 0.3–3 s per claim, so it runs after the answer, and in evals.
- **A fetch tool or a framework.** The brief allows one tool, so page reading is part of search; one ~300-line loop keeps parallelism, prompt order and streaming ours, and the UI is one JS file with no build step.

## Evaluation

`npm test`: 124 offline unit tests. `npm run eval`: 15 scenarios with a fixed clock and fixture history — the brief's questions reworded, reasoning with no search, comparisons — judged against a rubric plus search-use, grounding and upheld checks. Two runs at each effort (`evals/effort/`): at low, 30/30 behaviour checks and 98% judge; off, 93%, the misses being wrong answers. DeepSeek judging DeepSeek was the harness's weakest part, so Claude re-graded one run blind (`evals/second-judge/`). The judges agree on 92% of lines, and every disagreement is a lenient DeepSeek pass, including a thinking-off answer that contradicts itself. Rewordings found real gaps ("on the 3rd", "last Tues", "3/11" read month first for a London user). Those now resolve, with tests.

upheld caught what reading the answers didn't: in then/now tables one citation covered a row, so old values were cited to today's page. Citing each cell separately took supported citations from 8 of 35 to 17 of 28 (`evals/last-run/`). The grounding check is cruder but always on: upheld agreed with all 5 of its flags. It also flagged correct totals (15 seats × $10), half the flags on a Linear/Jira/Height comparison, so it now redoes such sums and names the page a misplaced figure is on. With one figure per claim made 20% wrong it catches 309 of 358 across the four effort runs, 4 fewer than before.

## With another week

- **A user profile:** keep the facts the user states ("20 people", "on AWS") in every message.
- **Watch for changes:** re-check saved claims on a schedule, and open the next chat with what changed.
- **Fix before showing:** the grounding check is milliseconds, so a flagged claim could go back for one more search first.
- **Sign-in,** so memory follows a person across devices; the demo keys it to a random-id cookie.
- Price extraction from pricing tables, better retrieval for long histories, a bigger hand-labelled eval set.
