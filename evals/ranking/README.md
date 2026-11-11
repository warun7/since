# The ranking eval

Whole-answer evals say whether the answer is right; they can't tell you whether *ranking* is
pulling its weight, because a better answer can hide a worse list. This scores the ranker alone.

`fixture.json` holds twelve queries and the real search results for them, recorded once with
`npx tsx evals/ranking/record.ts`. Each query names the host an official page lives on. The test
(`tests/ranking.test.ts`) runs `mergeAndRank` over the recorded results and asks where the first
official page landed.

| | hit@1 | hit@3 | MRR |
|---|---|---|---|
| `mergeAndRank` | 10/12 | 10/12 | 0.88 |
| provider order (control) | 10/12 | 10/12 | 0.86 |

The control is the point. A ranker that does nothing keeps the provider's order, so a test that
only says "an official page is in the top three" would pass without any ranker at all. The suite
asserts the ranker is never worse than the control, and it fails below ten of twelve in the top
three.

Where the ranker earns its place: the Hetzner queries disagree — the price query on its own puts
the vendor 14th, the plan-name query puts it first, and merging lifts it to 4th. Where it doesn't:
`node-lts` and `hetzner-cx23` stay at 4, so the vendor page is retrieved but not in the visible
three. That is the case a cross-encoder reranker would fix, and this eval is how its effect would
be measured.

Two notes:

- **The fixture is a snapshot** (10 November 2026). Search results drift, so re-record with the
  command above when the numbers stop reflecting the live web.
- **Only ranking is scored here.** Page text, passage selection and the answer are not; the
  fixture keeps them empty on purpose.
