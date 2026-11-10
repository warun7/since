# The citation-check run

`report.json` is the full record of run `2026-11-10T20-09-20`, made with `UPHELD_URL` set and thinking off, on the seven scenarios that existed then. It is kept for the citation numbers (upheld and the grounding check), not as the current default: `evals/effort/` has the runs behind `REASONING_EFFORT=low` over all fifteen scenarios. For each scenario it holds every turn's question, answer, search queries, sources and timings, plus the judge's verdict per rubric line, the grounding check, the planted-figure probe and upheld's audit. Model: `deepseek-flash`. upheld verifier: `judge:granite-guardian-3.3-8b@0.06`.

| Scenario | Judge | Searches | First token | Total | Grounding | upheld |
|---|---|---|---|---|---|---|
| recall-by-date | 100% | 1 | 2.55 s | 4.29 s | 2/5 | 2/5 |
| no-record | 100% | 0 | 1.02 s | 1.66 s | – | – |
| last-tuesday-postgres | 80% | 1 | 2.92 s | 4.99 s | 4/5 | 4/6 |
| crm-shortlist | 100% | 2 | 5.44 s | 8.27 s | 6/6 | 7/9 |
| fresh-fact | 100% | 1 | 2.16 s | 3.27 s | 5/6 | 2/6 |
| no-search-needed | 100% | 0 | 1.04 s | 1.23 s | – | – |
| follow-up | 100% | 0 | 0.49 s | 0.87 s | 1/1 | 0/1 |

The behaviour checks passed 7 of 7. The judge's average score was 97%, with 2.2 s to the first token and 3.5 s in total. The one failed rubric line asks for an old and a new price for every provider. The answer said it couldn't verify AWS's current price instead of making one up.

## The two citation checks

The **grounding check** grounded 18 of the 23 cited claims that carry a figure. It flagged 5, and upheld flagged each of those 5 too. Each flag is a figure that isn't on the page it cites:

- a $19 Neon price that the answer itself calls unconfirmed;
- a "12 months" AWS free-tier term, where the page gives 750 hours a month but no 12 months;
- a $10 Render tier cited to a page that doesn't give it;
- "Node 22" cited to pages that don't mention Node 22;
- "256" from a product name, on a claim that says the price couldn't be confirmed.

upheld supported 15 of the 27 cited claims. Its 7 other flags are claims the grounding check can't judge: claims without a figure, dates (which the grounding check skips), and figures that are on the page, such as Close's $109 and $99, where only reading the sentence shows whether each is attached to the right plan. I haven't hand-checked these 7, and upheld's judge raises some false alarms (about one good citation in five in earlier hand checks).

**Planted wrong figures.** For each grounded claim, one figure at a time was changed to a plausible wrong value, 20% higher in the same format. The grounding check flagged 27 of the 29 changes, and 20 of the 21 prices and percentages. It misses a wrong value only when that value also appears on the cited page. Across this run and the two before it, it caught 110 of 122 changes (79 of 83 prices and percentages).

upheld's full reports on three of these answers, claim by claim with the passages it read: [last-tuesday-postgres](https://upheld.varunsg.com/examples/since/last-tuesday-postgres), [recall-by-date](https://upheld.varunsg.com/examples/since/recall-by-date) and [fresh-fact](https://upheld.varunsg.com/examples/since/fresh-fact).

## Reproduce

```bash
UPHELD_MAX_CONCURRENT=1 upheld serve --port 8765   # optional, in another terminal
UPHELD_URL=http://127.0.0.1:8765 npm run eval        # writes evals/results/<runId>/
npx tsx evals/regrade-grounding.ts evals/results/<runId>   # re-score grounding only, no model calls
```

Answers change from run to run, because the model and the web do, so a new run gives different numbers.
