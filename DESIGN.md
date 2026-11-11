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

1. **Memory is context, not a tool.** The model's only tool is `web_search`. Code resolves "last Tuesday" or "3 November" to a date range in the user's timezone and loads those conversations plus keyword matches; an ambiguous phrase tries both dates. No extra call, and the model never does date maths.

2. **Answers are saved as claims.** A background call stores each answer's checkable claims (`Neon · Launch price: $0.106/CU-hour · source · as of 3 Nov`), so "has pricing changed?" compares saved values with today's. Pricing pages change without a new date, so it asks for the vendor's page (`site`) and for news since (`after`).

3. **Search that reads the page.** Up to 8 queries run in parallel, merged by reciprocal rank fusion plus DeepSeek's scores, deduplicated and capped per site. Pages are cut to the matching passages (~1,400 characters); thin official pages are fetched in full.

4. **Citations you can check.** `[n]` numbers stay fixed across a conversation. Every answer then gets a grounding check: each figure in a cited claim must appear in the passages of its source, or be a sum it can redo (15 seats × $10). No model, milliseconds, so the demo runs it too; it can't catch a misread figure that is on the page. `UPHELD_URL` swaps in [upheld](https://github.com/warun7/upheld) for model-based checking.

5. **The model sizes its own thinking.** No planner, no router: at low effort it decides from what the question means, not how it is worded. A search question shows `Thinking…` at 1 s, searches at 2 s, answers at 5–10 s; an easy one in about a second. The system prompt is static and first, so DeepSeek's cache covers everything but the new message.

The prompt enforces honesty: never invent a past conversation, say first when a date has no record, count only things dated after "since <date>".

**Hosted the same way.** A synchronous `Sql` interface: SQLite locally, a Durable Object per visitor on Cloudflare, with a Worker in front metering questions per visitor, per network and site-wide. upheld stays local: it needs its own models.

**Cost.** A searching answer spends about 0.6¢ on the Search API and 0.07¢ on reasoning, which is why a step caps at 8 queries and a turn at 3 rounds.

## Considered and rejected

- **A recall tool.** An extra round trip, and the model can forget to call it. Dates resolve in code.
- **A planner call.** 1–2 s on every message, and the first `web_search` call already is one.
- **A rolling summary for long chats.** Bounding the history and re-retrieving by date keeps the exact words; a summary paraphrases the thing being asked about.
- **mem0 or Supermemory.** They return the latest version of a fact; these questions need the exact words of a past answer. Each adds a call per message, as would embeddings (DeepSeek has none).
- **Thinking off, or effort per question.** Off is 4.6 s faster to the first token (p50) but got multi-step maths wrong in both eval runs (`evals/effort/`); at low nothing failed for lack of thinking, so a router would only add latency.
- **upheld before showing the answer.** 0.3–3 s per claim, so it runs after the answer.
- **A fetch tool or a framework.** The brief allows one tool, so page reading is part of search; a ~300-line loop keeps parallelism and streaming ours.

## Evaluation

`npm test`: 138 offline tests. `npm run eval`: 15 scenarios — the brief's questions reworded, reasoning with no search, comparisons — judged against a rubric. Two runs at each effort (`evals/effort/`): at low, 30/30 behaviour checks and 98%; off, 93%, the misses being wrong answers. Claude re-graded one run blind (`evals/second-judge/`): 92% agreement, every disagreement a lenient DeepSeek pass. Rewordings found real gaps ("on the 3rd", "3/11" read month-first in London); those now resolve, with tests. `evals/ranking/` scores the ranker alone against a do-nothing control (MRR 0.88 against 0.86).

upheld showed one citation covering a whole table row, so old values were cited to today's page; per-cell citations took support from 8 of 35 to 17 of 28 (`evals/last-run/`). The grounding check agreed with all 5 of its flags, caught a wrong-page citation the answer itself had the evidence for (now fixed before saving), and catches 309 of 358 planted wrong figures.

## With another week

- **A user profile:** keep the facts the user states ("20 people", "on AWS") in every message.
- **Watch for changes:** re-check saved claims on a schedule, and open the next chat with what changed.
- **Fix before showing:** wrong-page citations are fixed in code; a figure on no page at all could go back for one more search.
- **Sign-in,** so memory follows a person across devices; the demo keys it to a random-id cookie.
- Price extraction from pricing tables, better retrieval for long histories, a bigger hand-labelled eval set.
