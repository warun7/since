// How often would the grounding check notice a wrong figure? For each grounded claim in a real
// answer, change one figure to a plausible wrong value (20% higher, same format) and see whether
// the claim is then flagged. The misses are the wrong values that happen to be on the cited page
// too (another plan's price): the check can't tell those apart, a model-based check can.
import { checkGrounding, figures, type GroundingInput } from '../src/verify/grounding.js';

const MARKERS = /(?:\s*\[\d{1,3}(?:\s*,\s*\d{1,3})*\])+/g;

export interface GroundingProbe {
  /** Figures changed, one at a time. */
  tried: number;
  /** Changes the check flagged as "number not in source". */
  caught: number;
  /** The same for prices and percentages only. */
  pricesTried: number;
  pricesCaught: number;
  missed: string[];
}

function wrongValue(text: string): string | null {
  const m = text.match(/\d[\d,]*(?:\.\d+)?/);
  if (!m || /\d\.\d+\.\d/.test(text)) return null; // versions are left alone
  const digits = m[0];
  const n = Number(digits.replace(/,/g, ''));
  const decimals = (digits.split('.')[1] ?? '').length;
  let wrong = (n * 1.2).toFixed(decimals);
  if (wrong === digits.replace(/,/g, '')) wrong = (n + 1).toFixed(decimals);
  return text.replace(digits, wrong);
}

export function probeGrounding(input: GroundingInput): GroundingProbe {
  const probe: GroundingProbe = { tried: 0, caught: 0, pricesTried: 0, pricesCaught: 0, missed: [] };
  for (const claim of checkGrounding(input).claims) {
    if (claim.verdict !== 'grounded') continue;
    // Blank the markers so their numbers aren't changed, keeping offsets.
    const body = claim.text.replace(MARKERS, (m) => '\u0000'.repeat(m.length));
    for (const fig of figures(body, { skipContrast: true })) {
      const bad = wrongValue(fig.text);
      const at = body.indexOf(fig.text);
      if (!bad || at < 0) continue;
      const answer = claim.text.slice(0, at) + bad + claim.text.slice(at + fig.text.length);
      const flagged = checkGrounding({ ...input, answer }).claims.some((c) => c.missing.some((f) => f.text === bad));
      probe.tried++;
      if (flagged) probe.caught++;
      if (fig.unit) {
        probe.pricesTried++;
        if (flagged) probe.pricesCaught++;
      }
      if (!flagged) probe.missed.push(`${fig.text} -> ${bad}`);
    }
  }
  return probe;
}
