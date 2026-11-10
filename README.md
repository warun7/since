# since

A chat agent with one tool, web search, that remembers what it told you and checks what changed since.

Ask it "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?" and it works out which Tuesday you mean, finds that conversation, lists the prices it quoted then, re-checks each one against the vendors' pages and recent news, and tells you what moved, with sources.

How it's built, and why: [DESIGN.md](DESIGN.md).

## Run it

Needs Node 22+ and a [DeepSeek API key](https://platform.deepseek.com/api_keys). The one key covers both the model and web search (DeepSeek's Search API).

```bash
npm install
cp .env.example .env   # then set DEEPSEEK_API_KEY
npm run dev            # http://localhost:3000
```

Memory lives in `data/since.db` (SQLite). Delete it to start over.

### Try the memory questions straight away

A fresh install has no history, so "What did I ask you on 3 November?" gets an honest "I don't have a conversation from then". To try the recall-and-recheck path without waiting a week, seed some history. This runs three real conversations through the agent with backdated clocks (last Tuesday, last Monday, 3 November):

```bash
npm run seed
```

Then ask, for example:

- What did I ask you on 3 November? Is your answer still correct today?
- Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?
- On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?

## Other commands

```bash
npm run chat        # the same agent in the terminal
npm test            # unit tests: date resolution, recall, ranking, passages, citations (no network)
npm run eval        # scenario evals with an LLM judge; add -- --only crm-shortlist,no-record
npm run typecheck
```

## Optional: citation checks with upheld

[upheld](https://github.com/warun7/upheld) checks whether each cited sentence is backed by the source it cites. Run `UPHELD_MAX_CONCURRENT=1 upheld serve` (one audit at a time, since the local judge model can't run two at once) and set `UPHELD_URL=http://127.0.0.1:8000` in `.env`. After each answer has streamed, its citations are checked against the exact passages the model was shown, and the result appears under the answer. `npm run eval` also reports the support rate per scenario.
