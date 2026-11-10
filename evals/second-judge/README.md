# A second judge from another model family

The eval judge is DeepSeek, the same family as the model it grades. To see whether that matters, Claude (Anthropic) re-graded the same rubric lines from the same material the DeepSeek judge was shown: today's date, the history, earlier turns, the search queries, the answer and the rubric. The grading was blind: the DeepSeek verdicts were compared only afterwards. `verdicts.json` holds both verdicts for each line, with both reasons.

What was graded: every scenario in `evals/effort/low-2` (thinking low, 15 answers), plus the two thinking-off answers the DeepSeek judge failed for wrong maths (`evals/effort/off-1`, reason-capacity and reason-tiers). That makes 17 answers and 63 rubric lines.

| | |
|---|---|
| Lines where the two judges agree | 58 of 63 (92%) |
| Lines passed: DeepSeek / Claude | 59 / 54 |
| low-2 mean score: DeepSeek / Claude | 96% / 90% |
| off-1 reason-tiers: DeepSeek / Claude | 67% / 0% |

**Every disagreement goes the same way: DeepSeek passed and Claude failed.** Two of the five are misreadings of the material rather than judgement calls:

- **"Its searches are restricted to recent news or official pages."** DeepSeek said all queries used `site:` or `after:` in two CRM answers. One query in the first and three in the second used neither.
- **The off arm's pricing answer** heads with "700,000 events", and only its working reaches 610,000. DeepSeek passed both "gets 610,000" and "leads with the answer".
- **One judgement call.** In the professional rewrite, "otherwise, we risk missing our deadline" restates the deadline and drops the stakes of "we're toast". DeepSeek read it as keeping them.

**What it changes.** The DeepSeek judge is lenient by about 6 points, and most lenient on self-contradicting answers, which is how thinking-off fails. So the effort comparison in `evals/effort/` understates low's lead: on the pricing question Claude scores off at 0%, against 67% from DeepSeek. The two judges agree on the low arm's real misses (no next step after "no record", a remembered fact without its date).

**What it suggests.** Rubric lines that can be checked mechanically, such as "every query has a site or an after date", should be checked in code, like the search-count checks are, rather than left to a judge that can misread a list.

This is one re-grade by one model, not a hand-labelled set: it measures how much the two judges disagree, not which one is right. The two misreadings above can be checked against `verdicts.json` and `../effort/`.
