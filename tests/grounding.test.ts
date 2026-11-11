import { describe, expect, it } from 'vitest';
import { checkGrounding, citedSentences, figures, groundAnswer } from '../src/verify/grounding.js';
import type { Source } from '../src/types.js';

const source = (n: number, ...passages: string[]): Source => ({
  n,
  url: `https://example.com/${n}`,
  title: `Source ${n}`,
  site: 'example.com',
  passages,
});

const keys = (text: string) => figures(text).map((f) => `${f.unit}${f.key}`);

describe('figures', () => {
  it('reads prices, percentages, counts and versions, with their units', () => {
    expect(keys('$0.106 per CU-hour, a $1,500 fee, 20% off, 3,000 credits, 256 MB')).toEqual(['$0.106', '$1500', '%20', '3000', '256']);
    expect(keys('€19/month or 25 USD')).toEqual(['€19', '$25']);
    expect(keys('Node.js 26.13.0 replaces 26.12.1, and 24.11.12 is out')).toEqual(['26.13.0', '26.12.1', '24.11.12']);
  });

  it('treats "$25", "$25.00" and "$25 / month" as the same figure', () => {
    expect(keys('$25.00 / month')).toEqual(keys('$25/month'));
  });

  it('reads currency codes and multipliers', () => {
    expect(keys('USD 25, US$25, 25 USD')).toEqual(['$25', '$25', '$25']);
    expect(keys('$1.5k, $1,500, 185k users, $1.2B, $1.2 billion')).toEqual(['$1500', '$1500', '185000', '$1200000000', '$1200000000']);
    expect(keys('256m of RAM')).toEqual(['256']);
  });

  it('leaves out dates and names with digits in them', () => {
    expect(keys('Released 28 Oct 2026, on November 3, in August 2026, on 2026-11-10 at 14:00')).toEqual([]);
    expect(keys('announced on 9–10 Nov')).toEqual([]);
    expect(keys('db.t4g.micro on Q3 with GPT-4o')).toEqual(['4']);
  });

  it('keeps a year-like number that is a price or a size', () => {
    expect(keys('$2000 a year, 2048 MB')).toEqual(['$2000', '2048']);
  });

  it('gives the far end of a price range the same currency', () => {
    expect(keys('$2,900–3,500 a year, 15–20% off, $7 to $15')).toEqual(['$2900', '$3500', '15', '%20', '$7', '$15']);
  });

  it('can skip a figure the sentence says is not the value', () => {
    const text = '$10/month, not $6, down from $0.14, and the plan isn\'t a flat $19';
    expect(figures(text, { skipContrast: true }).map((f) => f.text)).toEqual(['$10']);
  });
});

describe('citedSentences', () => {
  it('splits cited sentences, joins a marker left after the full stop, and drops uncited ones', () => {
    const answer = '**Mostly still correct.** Supabase Pro is $25/month [1]. Render is $10/month.\n[2] Neon is metered [3].';
    expect(citedSentences(answer)).toEqual(['Supabase Pro is $25/month [1].', 'Render is $10/month. [2]', 'Neon is metered [3].']);
  });

  it('turns cited table cells into claims and leaves the remembered column out', () => {
    const answer = ['| Item | Then | Now |', '|---|---|---|', '| Render | $6/month | $10/month [7] |'].join('\n');
    expect(citedSentences(answer)).toEqual(['Render: $10/month [7].']);
  });
});

describe('checkGrounding', () => {
  const sources = [
    source(5, 'Launch: $0.106 per CU-hour, with a $5 minimum monthly spend.'),
    source(6, 'In August 2026 we lowered the minimum spend to $5/month.'),
    source(7, 'Basic-256mb: 256 MB RAM, $10/month. Legacy Starter: $7/month.'),
  ];

  it('grounds a claim whose figures are all in the passages it cites', () => {
    const { claims } = checkGrounding({ answer: 'Neon Launch is $0.106 per CU-hour with a $5/month minimum [5][6].', sources });
    expect(claims).toMatchObject([{ verdict: 'grounded', cites: [5, 6], missing: [] }]);
  });

  it('flags a figure that is not in the cited passages', () => {
    const { claims } = checkGrounding({ answer: 'Render Basic-256mb costs $12/month [7].', sources });
    expect(claims[0]).toMatchObject({ verdict: 'number not in source' });
    expect(claims[0]!.missing.map((f) => f.text)).toEqual(['$12']);
  });

  it('needs the unit to match: $6 is not grounded by "6 GB"', () => {
    const { claims } = checkGrounding({ answer: 'It costs $6 [8].', sources: [source(8, 'Includes 6 GB of storage.')] });
    expect(claims[0]!.verdict).toBe('number not in source');
  });

  it('looks for each figure in the source that closes its part of the sentence', () => {
    const answer = 'Neon is $0.106 per CU-hour [5], and Render is $10/month [7].';
    expect(checkGrounding({ answer, sources }).claims[0]!.verdict).toBe('grounded');
    const swapped = 'Neon is $10 per CU-hour [5], and Render is $0.106/month [7].';
    expect(checkGrounding({ answer: swapped, sources }).claims[0]!.missing.map((f) => f.text)).toEqual(['$10', '$0.106']);
  });

  it('does not hold a corrected old value against the source', () => {
    const { claims } = checkGrounding({ answer: 'The 256 MB instance is $10/month, not $6 [7].', sources });
    expect(claims[0]!.verdict).toBe('grounded');
  });

  it("does not hold the user's own bare figures against the source, but still checks prices", () => {
    const question = 'Which CRM suits a 20-person team at $25 a seat?';
    const { claims } = checkGrounding({ question, answer: 'For a 20-person team, Render is $25/month [7].', sources });
    expect(claims[0]!.missing.map((f) => f.text)).toEqual(['$25']);
  });

  it("doesn't count a bare 0 or 1, like the start of a range the page doesn't spell out", () => {
    const answer = 'Jira Standard: $9.70 per user (1–100 users) [1].';
    const { claims } = checkGrounding({ answer, sources: [source(1, 'raises the first band for Jira Standard to $9.70 per user. For 100 users on annual billing:')] });
    expect(claims[0]!.verdict).toBe('grounded');
  });

  it('says "no passage" when the cited source has no text to check', () => {
    const { claims } = checkGrounding({ answer: 'It costs $5 [9].', sources: [source(9)] });
    expect(claims[0]!.verdict).toBe('no passage');
  });

  it('only counts cited claims that carry a figure', () => {
    const answer = 'Neon scales to zero [5]. Supabase pauses idle projects. Render is $10/month [7].';
    expect(checkGrounding({ answer, sources }).claims).toHaveLength(1);
  });
});

describe('worked-out figures', () => {
  const question = 'Compare Linear, Jira and Height for a 15-person startup';
  const linear = source(6, 'Basic: $10 per user/month billed yearly. Business: $16 per user/month billed yearly, or $19.60 billed monthly.');

  it('accepts a total worked out from the cited prices and the team size, and shows the sum', () => {
    const answer = 'Linear Basic is about $150/mo for your team [6]. Budget an extra $90/mo for Business [6]. Basic is $1,800 a year [6].';
    const v = groundAnswer({ question, answer, sources: [linear] });
    expect(v.supported).toBe(3);
    expect(v.worked).toEqual([
      { figure: '$150', how: '= 15 × $10', source: '6' },
      { figure: '$90', how: '= 15 × ($16 − $10)', source: '6' },
      { figure: '$1,800', how: '= 15 × $10 × 12', source: '6' },
    ]);
  });

  it('takes the team size from the claim when the question gives none', () => {
    const v = groundAnswer({ answer: 'For 20 users, Basic is $200/mo [6].', sources: [linear] });
    expect(v.worked).toEqual([{ figure: '$200', how: '= 20 × $10', source: '6' }]);
  });

  it('reads the far end of a range as a price too, and allows the rounding the figure shows', () => {
    const v = groundAnswer({ question, answer: 'Business runs ~$2,900–3,500 a year [6].', sources: [linear] });
    expect(v.supported).toBe(1);
    expect(v.worked?.map((w) => `${w.figure} ${w.how}`)).toEqual(['$2,900 ≈ 15 × $16 × 12', '3,500 ≈ 15 × $19.60 × 12']);
  });

  it('still flags a total that does not add up', () => {
    const { claims } = checkGrounding({ question, answer: 'Linear Basic comes to $170/mo for the team [6].', sources: [linear] });
    expect(claims[0]).toMatchObject({ verdict: 'number not in source', worked: [] });
  });

  it('allows a rounded price only when the answer says it is rounded', () => {
    const jira = source(1, 'Standard: $8.15 per user/month.');
    expect(checkGrounding({ answer: 'Jira Standard is about $8 a user [1].', sources: [jira] }).claims[0]!.verdict).toBe('grounded');
    expect(checkGrounding({ answer: 'Jira Standard is $8 a user [1].', sources: [jira] }).claims[0]!.verdict).toBe('number not in source');
  });

  it('names the page a missing figure is on when the claim cites another', () => {
    const shown = [source(17, 'Jira Standard rose to $9.70 per user in October.')];
    const v = groundAnswer({ answer: 'Jira Standard is $8.15 (monthly $9.70) [1].', sources: [source(1, 'Standard: $8.15 per user/month.')], shown });
    expect(v.flagged).toEqual([
      { claim: 'Jira Standard is $8.15 (monthly $9.70) [1].', verdict: 'in another source', source: '1', note: 'Not in the cited text: $9.70 (in [17])' },
    ]);
  });
});

describe('groundAnswer', () => {
  it('reports in the Verification shape, with the missing figures as the note', () => {
    const answer = 'Render is $10/month [7]. The legacy Starter was $9/month [7].';
    const v = groundAnswer({ answer, sources: [source(7, 'Basic-256mb: $10/month. Legacy Starter: $7/month.')] });
    expect(v).toMatchObject({
      status: 'ok',
      verifier: 'grounding',
      supported: 1,
      cited: 2,
      flagged: [{ claim: 'The legacy Starter was $9/month [7].', verdict: 'number not in source', source: '7', note: 'Not in the cited text: $9' }],
    });
  });
});
