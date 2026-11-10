# since

A chat agent with one tool, web search, that remembers what it told you and checks what changed since.

Ask it "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?" and it works out which Tuesday you mean, finds that conversation, lists the prices it quoted then, re-checks each one against the vendors' pages and recent news, and tells you what moved, with sources.

**Try it:** https://since.varunsg.com. Each visitor gets their own memory. To try the memory questions, click **Add example history** first.

How it's built, and why: [DESIGN.md](DESIGN.md).

## Run it

Needs Node 22+ and a [DeepSeek API key](https://platform.deepseek.com/api_keys). The one key covers both the model and web search (DeepSeek's Search API).

```bash
npm install
cp .env.example .env   # then set DEEPSEEK_API_KEY
npm run dev            # http://localhost:3000, this machine only (HOST=0.0.0.0 to share it)
```

Memory lives in `data/since.db` (SQLite). Delete it to start over.

### Try the memory questions straight away

A fresh install has no history, so "What did I ask you on 3 November?" gets an honest "I don't have a conversation from then". To try the recall-and-recheck path without waiting a week, click **Add example history** on the new-chat screen, or run:

```bash
npm run seed
```

Either one runs three real conversations through the agent with backdated clocks (last Tuesday, last Monday, 3 November).

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

## Hosting

The live demo runs on Cloudflare, from [`cloud/`](cloud/). The code is the same as `npm run dev`; only the storage and the entry point change. A Worker gives each visitor an id in a cookie and forwards their API calls to that visitor's own Durable Object. The Durable Object holds the visitor's memory in its built-in SQLite, behind the same `MemoryStore` as the local SQLite file. A memory is deleted 30 days after its last visit, or at once with **Forget everything** in the sidebar, which also retires the cookie. The cookie holds a random id and is the only key to the memory: there's no sign-in, so whoever has the cookie has the memory.

So the demo can't be run up: 40 questions a day per visitor, 60 per network (IP address) and 1,500 for the whole site, charged only once a question has passed every check (networks are counted by an HMAC under a key that changes daily and is then deleted, never by address); 30 API requests a minute per network; and at most 8 searches per step, 3 steps per question. The 1,500 caps spending, not availability: enough networks asking real questions could still use up a day's allowance. Every response has a strict Content-Security-Policy (no images from other sites, so an answer can't leak memory through an image URL), and changes are accepted only from the site's own pages.

`since.varunsg.com` is a tiny Cloudflare Pages site ([`cloud/pages/_worker.js`](cloud/pages/_worker.js)) that passes every request to the Worker. The domain's DNS is at Hostinger, and a Pages site can take a domain by CNAME where a Worker can't. The pages.dev and workers.dev addresses redirect to it, so each person has one address and one memory.

To deploy your own (needs a Cloudflare account; `cloud/` has its own dependencies, so the root install stays small):

```bash
npm install && cd cloud && npm install
npx cf auth login
npx cf deploy --secrets-file ../.env   # uploads the keys in .env as Worker secrets
```

Set `CANONICAL_ORIGIN` in `cloud/cloudflare.config.ts` to your own address, or remove it to serve from workers.dev. `npx cf dev` in `cloud/` runs the Worker locally (put the key in `cloud/.dev.vars`).

## Optional: citation checks with upheld

[upheld](https://github.com/warun7/upheld) checks whether each cited sentence is backed by the source it cites. Run `UPHELD_MAX_CONCURRENT=1 upheld serve` (one audit at a time, since the local judge model can't run two at once) and set `UPHELD_URL=http://127.0.0.1:8000` in `.env`. After each answer has streamed, its citations are checked against the exact passages the model was shown, and the result appears under the answer. `npm run eval` also reports the support rate per scenario.
