// Eval scenarios for the chat agent.
//
// FIXTURES ARE TEST DATA. The earlier conversations below (questions, answers, sources and
// the claims recorded from them) are written for this harness. Prices, plans and dates are
// illustrative, not quotes. The live turns run against the real web, so a fixture value that
// differs from today's price is expected: that difference is what the scenarios test.
//
// Dates: "now" for each scenario is fixed, so relative phrases ("last Tuesday") resolve the
// same way on every run. Fixture answers use [n] markers that match their fixture sources.

export interface FixtureSource {
  n: number;
  url: string;
  title: string;
  site: string;
}

export interface FixtureTurn {
  askedAt: string;
  question: string;
  answer: string;
  claims?: Array<{ subject: string; attribute: string; value: string; sourceUrl?: string }>;
  entities?: string[];
  topics?: string[];
  title?: string;
  /** Sources the fixture answer cites, numbered as in the answer. Added to the spec: needed to seed citations. */
  sources?: FixtureSource[];
}

export interface Scenario {
  id: string;
  description: string;
  now: string;
  tz: string;
  history: FixtureTurn[];
  turns: string[];
  rubric: string[];
  expect?: { maxSearchSteps?: number; minSearchSteps?: number };
}

// ───────────────────────────── Fixture: Postgres hosting (Tue 3 Nov 2026) ─────────────────────────────

const POSTGRES_QUESTION =
  'What are the cheapest managed Postgres hosting options right now for a small production app? Compare the entry paid plans.';

const postgresTurn: FixtureTurn = {
  askedAt: '2026-11-03T10:14:00Z',
  title: 'Cheapest managed Postgres hosting',
  question: POSTGRES_QUESTION,
  answer: `For a small production app, these are the cheapest managed Postgres options I'd shortlist, comparing the entry paid plans:

- **Neon, Launch plan**: about $19/month, with autoscaling compute and point-in-time restore [1].
- **Supabase, Pro plan**: $25/month per project, including daily backups and 8 GB of database storage [2].
- **Render, Basic-256mb Postgres**: about $6/month, but the smallest tier has no high availability [3].
- **AWS RDS, db.t4g.micro (single-AZ)**: roughly $12/month on-demand, before storage and backup charges [4].

Render is the cheapest entry point. Neon and Supabase cost a little more and add features you'd otherwise have to run yourself. Prices change, so check the pricing pages before you commit.`,
  entities: ['Neon', 'Supabase', 'Render', 'AWS RDS'],
  topics: ['postgres', 'hosting', 'pricing'],
  sources: [
    { n: 1, url: 'https://neon.tech/pricing', title: 'Pricing - Neon', site: 'neon.tech' },
    { n: 2, url: 'https://supabase.com/pricing', title: 'Pricing & Fees | Supabase', site: 'supabase.com' },
    { n: 3, url: 'https://render.com/pricing', title: 'Pricing - Render', site: 'render.com' },
    {
      n: 4,
      url: 'https://aws.amazon.com/rds/postgresql/pricing/',
      title: 'Amazon RDS for PostgreSQL Pricing',
      site: 'aws.amazon.com',
    },
  ],
  claims: [
    { subject: 'Neon', attribute: 'Launch plan price', value: '$19/month', sourceUrl: 'https://neon.tech/pricing' },
    { subject: 'Supabase', attribute: 'Pro plan price', value: '$25/month', sourceUrl: 'https://supabase.com/pricing' },
    { subject: 'Render', attribute: 'Basic-256mb Postgres price', value: '$6/month', sourceUrl: 'https://render.com/pricing' },
    {
      subject: 'AWS RDS',
      attribute: 'db.t4g.micro single-AZ on-demand price',
      value: '~$12/month',
      sourceUrl: 'https://aws.amazon.com/rds/postgresql/pricing/',
    },
  ],
};

const postgresHistory: FixtureTurn[] = [postgresTurn];

// ───────────────────────────── Fixture: CRM shortlist (Mon 9 Nov 2026) ─────────────────────────────

const crmTurn: FixtureTurn = {
  askedAt: '2026-11-09T14:05:00Z',
  title: 'CRM shortlist for a 20-person sales team',
  question: "We're picking a CRM for a 20-person sales team. Shortlist the 5 best options with per-seat pricing.",
  answer: `Here's a shortlist of five CRMs for a 20-person sales team, with per-seat pricing billed monthly:

1. **HubSpot Sales Hub, Professional**: $90/seat/month [1]
2. **Pipedrive, Growth**: $49/seat/month [2]
3. **Salesforce Starter Suite**: $25/user/month [3]
4. **Zoho CRM, Professional**: $23/user/month [4]
5. **Close, Growth**: $109/seat/month [5]

At 20 seats that comes to about $1,800/month on HubSpot, $980 on Pipedrive, $500 on Salesforce Starter Suite, $460 on Zoho and $2,180 on Close. Zoho and Salesforce are the cheapest. HubSpot and Close cost the most but include more built-in sales tooling.`,
  entities: ['HubSpot Sales Hub', 'Pipedrive', 'Salesforce Starter Suite', 'Zoho CRM', 'Close'],
  topics: ['crm', 'sales', 'pricing'],
  sources: [
    { n: 1, url: 'https://www.hubspot.com/pricing/sales', title: 'Sales Hub Pricing | HubSpot', site: 'hubspot.com' },
    { n: 2, url: 'https://www.pipedrive.com/en/pricing', title: 'Pipedrive Pricing', site: 'pipedrive.com' },
    { n: 3, url: 'https://www.salesforce.com/sales/pricing/', title: 'Sales Cloud Pricing | Salesforce', site: 'salesforce.com' },
    { n: 4, url: 'https://www.zoho.com/crm/pricing/', title: 'Zoho CRM Pricing', site: 'zoho.com' },
    { n: 5, url: 'https://close.com/pricing', title: 'Pricing | Close', site: 'close.com' },
  ],
  claims: [
    { subject: 'HubSpot Sales Hub', attribute: 'Professional price per seat', value: '$90/seat/month', sourceUrl: 'https://www.hubspot.com/pricing/sales' },
    { subject: 'Pipedrive', attribute: 'Growth price per seat', value: '$49/seat/month', sourceUrl: 'https://www.pipedrive.com/en/pricing' },
    { subject: 'Salesforce Starter Suite', attribute: 'price per user', value: '$25/user/month', sourceUrl: 'https://www.salesforce.com/sales/pricing/' },
    { subject: 'Zoho CRM', attribute: 'Professional price per user', value: '$23/user/month', sourceUrl: 'https://www.zoho.com/crm/pricing/' },
    { subject: 'Close', attribute: 'Growth price per seat', value: '$109/seat/month', sourceUrl: 'https://close.com/pricing' },
  ],
};

const crmHistory: FixtureTurn[] = [crmTurn];

// ───────────────────────────── Fixture: Node.js version (Tue 3 Nov 2026) ─────────────────────────────

const nodeTurn: FixtureTurn = {
  askedAt: '2026-11-03T09:20:00Z',
  title: 'Latest Node.js version',
  question: "What's the latest stable version of Node.js?",
  answer: `The latest stable release is **Node.js 26.12.1**, published on 21 October 2026 [1]. Node 26 is due to become the Active LTS line on 28 October 2026 [1].`,
  entities: ['Node.js'],
  topics: ['nodejs', 'releases'],
  sources: [{ n: 1, url: 'https://nodejs.org/en/about/previous-releases', title: 'Node.js Releases', site: 'nodejs.org' }],
  claims: [{ subject: 'Node.js', attribute: 'latest stable version', value: '26.12.1', sourceUrl: 'https://nodejs.org/en/about/previous-releases' }],
};

// ───────────────────────────── Scenarios ─────────────────────────────

export const scenarios: Scenario[] = [
  {
    id: 'recall-by-date',
    description: 'Recall an earlier question by its date, then re-check its claims against current sources.',
    now: '2026-11-10T15:00:00Z',
    tz: 'Europe/London',
    history: postgresHistory,
    turns: ['What did I ask you on 3 November? Is your answer still correct today?'],
    rubric: [
      'Restates the 3 November question accurately (managed Postgres hosting for a small production app, entry paid plans).',
      'Re-checks the earlier claims against current sources rather than simply repeating the old answer.',
      'For each provider (Neon, Supabase, Render, AWS RDS), says whether its price still holds, changed (old -> new), or could not be verified.',
      'Cites sources with [n] markers.',
      'Uses absolute dates (for example 3 November 2026), not only "last week" or "today".',
    ],
  },
  {
    id: 'no-record',
    description: 'No memory of the referenced date: must say so instead of inventing a conversation.',
    now: '2026-11-10T15:00:00Z',
    tz: 'Europe/London',
    history: [],
    turns: ['What did I ask you on 3 November?'],
    rubric: [
      'Says plainly that it has no record of a conversation on 3 November 2026.',
      'Does not invent a past question or answer.',
      'Offers a useful next step (for example, asking the question again, or describing what they remember).',
      'Is short: no more than about four sentences.',
    ],
    expect: { maxSearchSteps: 0 },
  },
  {
    id: 'last-tuesday-postgres',
    description: 'Resolve "last Tuesday" to a date, then compare the old Postgres prices with current ones.',
    now: '2026-11-10T15:00:00Z',
    tz: 'Europe/London',
    history: postgresHistory,
    turns: ['Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?'],
    rubric: [
      'Identifies last Tuesday as 3 November 2026.',
      'Covers each provider from that answer by name (Neon, Supabase, Render, AWS RDS).',
      'For each provider, compares the earlier price to the current price (both stated).',
      'Cites current sources with [n] markers.',
      'Gives a clear verdict up front (for example, which prices changed and which did not).',
    ],
  },
  {
    id: 'crm-shortlist',
    description: 'Follow up a shortlist: pricing changes and notable launches since Monday 9 November.',
    now: '2026-11-12T10:00:00Z',
    tz: 'Europe/London',
    history: crmHistory,
    turns: ['On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?'],
    rubric: [
      'Names all five tools from the shortlist (HubSpot Sales Hub, Pipedrive, Salesforce Starter Suite, Zoho CRM, Close).',
      'For each tool, says whether its pricing changed since 9 November 2026 and whether anything notable shipped since then.',
      'Its searches are restricted to recent news or official pages (queries use an after date or a site restriction).',
      'Cites sources with [n] markers.',
      'Is scannable: a table or one line per tool.',
    ],
  },
  {
    id: 'fresh-fact',
    description: 'A time-sensitive fact with no history: must search, answer specifically and date it.',
    now: new Date().toISOString(),
    tz: 'Europe/London',
    history: [],
    turns: ["What's the latest stable version of Node.js?"],
    rubric: [
      'Gives a specific version number.',
      'Cites a source with an [n] marker.',
      'Mentions a date (when the release was made, or when the answer was current).',
    ],
    expect: { minSearchSteps: 1 },
  },
  {
    id: 'no-search-needed',
    description: 'A pure rewrite: no web search should be needed.',
    now: '2026-11-10T15:00:00Z',
    tz: 'Europe/London',
    history: [],
    turns: ["Rewrite this to sound more professional: 'we gotta ship this by friday or we're toast'"],
    rubric: [
      'Gives a professional rewrite of the sentence (it keeps the Friday deadline and the stakes).',
      'Is brief: the rewrite, plus at most one short sentence of commentary.',
    ],
    expect: { maxSearchSteps: 0 },
  },
  {
    id: 'follow-up',
    description: 'A follow-up in the same conversation: short, consistent with the first answer, no new search.',
    now: '2026-11-10T15:00:00Z',
    tz: 'Europe/London',
    history: [],
    turns: ['Compare Neon and Supabase free tiers.', 'Which would you pick for a weekend hobby project, in one sentence?'],
    rubric: [
      'Answers in about one sentence.',
      'Is consistent with the first answer about Neon and Supabase free tiers (it picks one of the two that the first answer supports).',
      'Does not run an unnecessary new search for this follow-up.',
    ],
    expect: { maxSearchSteps: 0 },
  },
  // ── The hard set: questions that need thinking or digging, plus wording checks. ──
  // Paraphrase pairs ask an existing scenario's question in other words; a control pair uses
  // similar words for a different need. Behaviour should follow the need, not the wording.
  {
    id: 'reason-capacity',
    description: 'Capacity maths with no search: one right number, then a judgement call.',
    now: '2026-11-10T15:00:00Z',
    tz: 'Europe/London',
    history: [],
    turns: [
      'Our API serves 1.2 million requests a day. The busiest hour carries 15% of the daily traffic, and each request uses 80 ms of CPU on one core. Our autoscaler targets 60% CPU. How many cores do we need at peak? And is a 60% target sensible if p99 latency has to stay under 200 ms?',
    ],
    rubric: [
      'Gets 7 cores at peak: 50 requests a second × 0.08 s = 4 busy cores, divided by 0.6 = 6.7, rounded up to 7.',
      'Leads with the number, and keeps the working short and readable (no LaTeX such as \\boxed).',
      'Gives a reasoned view on the 60% target versus the 200 ms p99, such as headroom for bursts and queueing as utilisation rises.',
    ],
    expect: { maxSearchSteps: 0 },
  },
  {
    id: 'reason-tiers',
    description: 'Tiered-pricing break-even with no search: one right answer.',
    now: '2026-11-10T15:00:00Z',
    tz: 'Europe/London',
    history: [],
    turns: [
      'Plan A is free for the first 10,000 events a month, then $0.50 per 1,000 events. Plan B is $300 a month flat for up to 1 million events, then $0.20 per 1,000 above that. Above what monthly volume is Plan B cheaper?',
    ],
    rubric: [
      'Gets 610,000 events a month: 0.5 × (N − 10) = 300 gives N = 610 thousand.',
      'Says Plan B stays cheaper above 1 million events too, since its overage rate is lower.',
      'Leads with the answer, and keeps the working short and readable (no LaTeX such as \\boxed).',
    ],
    expect: { maxSearchSteps: 0 },
  },
  {
    id: 'tradeoff-advice',
    description: 'An engineering judgement call: prioritise under real constraints.',
    now: '2026-11-10T15:00:00Z',
    tz: 'Europe/London',
    history: [],
    turns: [
      "We're 4 engineers running a Django monolith on one EC2 instance, with Postgres on the same machine. Traffic doubled this quarter, and every deploy causes about 30 seconds of downtime. What should we change first, and what should we deliberately not do yet?",
    ],
    rubric: [
      'Picks a first change and justifies it with their constraints (for example moving Postgres off the box, or zero-downtime deploys behind a load balancer).',
      'Gives an order for the next steps rather than an unranked list of options.',
      'Names things not to do yet (for example microservices or Kubernetes) and says why, for a team of four.',
      'Is concrete enough to act on: names specific techniques or services.',
    ],
  },
  {
    id: 'broad-compare',
    description: 'A comparison that needs digging: limits and overage rules for three providers.',
    now: new Date().toISOString(),
    tz: 'Europe/London',
    history: [],
    turns: [
      'Which of Vercel, Netlify and Cloudflare Pages has the most generous free tier for a static site that uses about 200 GB of bandwidth a month, and what happens with each one if I go past its free limit?',
    ],
    rubric: [
      "States each provider's free bandwidth allowance (or that it has none), each with a citation.",
      'Says which of the three fits 200 GB a month on the free tier.',
      'For each provider, says what happens past the limit (charged, paused, or must upgrade).',
      'Gives a clear verdict up front.',
    ],
    expect: { minSearchSteps: 1 },
  },
  {
    id: 'vague-it',
    description: 'A vague follow-up: "it" could mean either option, so cover both or say which.',
    now: '2026-11-10T15:00:00Z',
    tz: 'Europe/London',
    history: [],
    turns: ['Compare Neon and Supabase free tiers.', 'Is it still free if I go over the limits?'],
    rubric: [
      'Covers both Neon and Supabase, or says which one it takes "it" to mean and why.',
      'For each one covered, says what happens past the free limits (for example paused, throttled, or billed).',
      'Answers rather than only asking a clarifying question.',
    ],
  },
  {
    id: 'crm-shortlist-paraphrase',
    description: 'crm-shortlist in other words: the same need should get the same behaviour.',
    now: '2026-11-12T10:00:00Z',
    tz: 'Europe/London',
    history: crmHistory,
    turns: ["Monday's five CRM picks for our twenty sellers: anything about them I should know this week?"],
    rubric: [
      'Names all five tools from the shortlist (HubSpot Sales Hub, Pipedrive, Salesforce Starter Suite, Zoho CRM, Close).',
      'For each tool, says whether its pricing changed since 9 November 2026 and whether anything notable shipped since then.',
      'Its searches are restricted to recent news or official pages (queries use an after date or a site restriction).',
      'Cites sources with [n] markers.',
      'Is scannable: a table or one line per tool.',
    ],
  },
  {
    id: 'recall-by-date-paraphrase',
    description: 'recall-by-date in other words, with the date given as "the 3rd".',
    now: '2026-11-10T15:00:00Z',
    tz: 'Europe/London',
    history: postgresHistory,
    turns: ['Remind me what we went over on the 3rd, and does it still hold?'],
    rubric: [
      'Restates the 3 November question accurately (managed Postgres hosting for a small production app, entry paid plans).',
      'Re-checks the earlier claims against current sources rather than simply repeating the old answer.',
      'For each provider (Neon, Supabase, Render, AWS RDS), says whether its price still holds, changed (old -> new), or could not be verified.',
      'Cites sources with [n] markers.',
      'Uses absolute dates (for example 3 November 2026), not only "last week" or "today".',
    ],
  },
  {
    id: 'control-recalled-fact',
    description: 'Control for fresh-fact: similar words, but it asks what was said, so memory answers it.',
    now: '2026-11-10T15:00:00Z',
    tz: 'Europe/London',
    history: [nodeTurn],
    turns: ['When we talked on 3 November, what did you tell me the latest Node.js version was?'],
    rubric: [
      'Reports the version from the 3 November answer: Node.js 26.12.1.',
      'Dates it: says this was the answer on 3 November 2026.',
      'Does not present 26.12.1 as the current version without saying it may have changed.',
    ],
    expect: { maxSearchSteps: 0 },
  },
];
