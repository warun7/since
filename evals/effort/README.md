# Thinking off or low: the runs behind the default

Four full eval runs on 10 November 2026: two with `REASONING_EFFORT=off` and two with `REASONING_EFFORT=low`. Each run covers all 15 scenarios (17 turns, since some scenarios have a follow-up). The model is `deepseek-flash` and the judge is DeepSeek with thinking off. upheld was not used. Each folder holds one run's `report.json`.

| | thinking off | thinking low |
|---|---|---|
| judge score | 93% | 98% |
| behaviour checks | 30/30 | 30/30 |
| first token, p50 / p95 | 2.81 s / 7.27 s | 7.40 s / 15.92 s |
| total, p50 / p95 | 5.07 s / 10.17 s | 10.21 s / 18.69 s |
| reasoning tokens a turn | 0 | 599 |
| search rounds a turn | 0.88 | 1.47 |
| words a final answer | 227 | 211 |
| grounding flags | 17 of 104 (16%) | 16 of 97 (16%) |

By kind of question, using final turns from both runs:

| | off: first token (median) | off: judge | low: first token (median) | low: reasoning tokens (median) | low: judge |
|---|---|---|---|---|---|
| easy, no search (4 scenarios) | 0.72 s | 100% | 1.27 s | 94 | 93% |
| reasoning, no search (3) | 0.51 s | 78% | 4.78 s | 628 | 100% |
| search (8) | 3.71 s | 95% | 9.86 s | 726 | 100% |

**What thinking buys.** Most of the off arm's misses were wrong answers. In both runs it gave the wrong core count for the capacity question (it opened with "64" or "67 cores" and then corrected itself in the text). In both runs it also got the pricing-tier question wrong ("700,000 events" against 610,000) or left half of it out. It never found AWS RDS's current price for the Postgres comparison. The low arm got all of these right in both runs. Its two misses were presentation: once it gave no next step after "I have no record", and once it gave a remembered fact without its date.

**What it costs.** On easy questions about 0.5 s, because the model thinks for a few dozen tokens and stops. On reasoning questions about 4 s of thinking. On search questions about 6 s to the first token. Most of that is one extra search round: the model goes back to check a figure it found (for example "Version 26.13.1 Node.js release"). In reasoning tokens it comes to about 0.07¢ a turn. Each extra round adds a few Search API requests at $0.75 per 1,000.

**What it doesn't change.** The grounding flag rate is 16% in both arms, so thinking doesn't make citations more accurate. That is the grounding check's job.

**Why not `high`, or effort chosen per question.** At low effort the model already scales its thinking to what the question means rather than how it's worded: 13–17 reasoning tokens for "What did I ask you on 3 November?" with nothing on record, 1,700–2,000 for the capacity maths. Nothing scored below 100% at low for lack of thinking, so a router or a `high` step would add latency with nothing to fix.

## Reproduce

```bash
REASONING_EFFORT=off npm run eval    # writes evals/results/<runId>-off/
REASONING_EFFORT=low npm run eval    # the two can run at the same time
npx tsx evals/compare.ts evals/results/<run-off> evals/results/<run-low>
npx tsx evals/compare.ts evals/effort/off-1 evals/effort/off-2 evals/effort/low-1 evals/effort/low-2   # these runs
```

Answers change from run to run, because the model and the web do. With two runs an arm, a single-run difference on one scenario is noise. The reasoning-question misses at off were not: they happened in both runs.
