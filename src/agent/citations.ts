// Citation markers are [n] or [n, m]; a markdown link "[3](url)" is not one.
// The leading spaces are captured so a removed marker doesn't leave "word ." behind.
const MARKER = /( *)\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\](?!\()/g;

function numbers(inner: string): number[] {
  return inner.split(',').map((s) => Number(s.trim()));
}

/** Source numbers in the order the text first cites them. */
export function citedNumbers(text: string): number[] {
  const seen = new Set<number>();
  for (const m of text.matchAll(MARKER)) for (const n of numbers(m[2])) seen.add(n);
  return [...seen];
}

/**
 * Drop citation numbers that don't belong to any source the model was actually shown.
 * A made-up [7] is worse than no citation: it points the reader at the wrong page.
 */
export function dropUnknownCitations(text: string, known: Set<number>): string {
  return text.replace(MARKER, (_m, space: string, inner: string) => {
    const kept = numbers(inner).filter((n) => known.has(n));
    return kept.length ? `${space}[${kept.join(', ')}]` : '';
  });
}

/** Remove all markers, e.g. from a past answer whose numbers belong to another conversation. */
export function stripCitations(text: string): string {
  return text.replace(MARKER, '');
}
