# since: design

Every example question is about time: what did I ask on 3 November, is it still right, what changed since Monday? So `since` saves each answer as a dated list of claims, and checks them against today in the user's timezone.

## How a turn works

```
message ─► recall: resolve the dates, look them up in SQLite (~5 ms, no LLM)
        ─► CONTEXT: today, the resolved dates, past exchanges and their claims
        ─► DeepSeek (streamed) ─┬─► answer with [n] citations
                                └─► web_search(queries[]) ─► DeepSeek Search, in parallel
                                    ─► merge, rank, keep the best passages ─► model again (≤ 3 rounds)
then, in the background: save title, summary and claims · optional upheld check
```

1. **Memory is context, not a tool.** The model's only tool is `web_search`. Before it runs, code turns "last Tuesday" or "3 November" into a date range in the user's timezone and loads those conversations from SQLite, plus keyword matches. A phrase that could mean two dates tries both. The model can't skip recall, recall costs no extra call, and the model never does date maths.
2. **Answers are saved as claims.** After each answer, a background call saves its checkable claims (`Neon · Launch price: $0.106/CU-hour · source · as of 3 Nov`). "Has pricing changed?" becomes a comparison of saved values with today's. Pricing pages change without a new date, so the prompt asks for the vendor's page (`site`) as well as news since the date (`after`).
3. **Search that reads the page.** One call runs up to 8 queries in parallel. Results are merged (reciprocal rank fusion plus DeepSeek's relevance scores), deduplicated and capped per site, and every query keeps its best result so one vendor can't crowd out the rest. Pages are cut to the passages that match the query (about 1,400 characters); thin official pages are fetched in full.
4. **Citations you can check.** `[n]` numbers stay fixed across a conversation, and numbers the model wasn't shown are removed. With `UPHELD_URL` set, [upheld](https://github.com/warun7/upheld), my citation checker, tests each cited claim against the passages the model saw, after the answer has streamed.
5. **Fast by design.** There is no planner call. The system prompt never changes and comes first, so DeepSeek's prompt cache covers everything but the new message. The model is `deepseek-flash` with thinking off. Follow-ups start in under 1 s; a fresh fact takes 3–4 s; re-checking five CRMs, 7–10 s.

The prompt also enforces honesty: never invent a past conversation, say first when a date has no record, and count only things dated after "since <date>".

**Hosted the same way.** Memory sits behind a small synchronous `Sql` interface. Locally it's a SQLite file; on Cloudflare each visitor gets a Durable Object with its own built-in SQLite. The store, schema and API are the same code, and visitors never see each other's history. A Worker in front sets the visitor cookie and rate-limits each network; questions are counted per visitor, per network and site-wide, and only once they've passed every check.

## Considered and rejected

- **A recall tool.** An extra round trip, and the model can forget to call it. Dates can be resolved in code.
- **A planner call.** It adds 1–2 s to every message.
- **mem0 or Supermemory.** Both keep facts about the user and return the latest version. These questions need the exact words of a past answer, found by date. They also add a second API key and a network call per message (as would embeddings: DeepSeek has none). They would suit a user profile (below).
- **Thinking mode.** Seconds slower to the first token. Resolved dates and saved claims do that work up front.
- **upheld before showing the answer.** 0.3–3 s per claim, so it runs after the answer, and in evals.
- **A fetch tool, an agent framework, Next.js.** The brief allows one tool, so page reading is part of search. The agent loop is about 250 lines, so parallelism, prompt order and streaming stay under my control. The UI is one JS file, no build step.

## Evaluation

`npm test`: 85 offline unit tests (dates across timezones, recall, ranking, passages, citations, API limits). `npm run eval`: seven scenarios with a fixed clock and fixture history, scored by an LLM judge against a rubric, plus checks on search use and upheld's support rate. Last full run: 7/7 behaviour checks, a 100% judge score, 3.4 s average to the first token, 4.8 s in total.

upheld found what reading the answers didn't: a then/now table row mixes an old value with a new citation, so whole rows failed. Checking each cited cell separately raised support from 8/35 to 17/28. Most remaining flags are real errors, such as an old number cited to today's page.

## With another week

- **A user profile:** keep facts the user states ("20 people", "on AWS") and include them in every message.
- **Watch for changes:** re-check saved claims on a schedule, and open the next chat with what changed.
- **Tighter diffs:** require each "now" value to be quoted from a passage.
- **Fix before showing:** re-search flagged claims, once a faster checker fits the time budget.
- **Sign-in,** so memory follows a person across devices; the demo keys it to a cookie holding a random id, so whoever has the cookie has the memory.
- Price extraction from pricing tables, better retrieval for long histories, a bigger hand-labelled eval set.
