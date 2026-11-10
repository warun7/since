import { describe, expect, it } from 'vitest';
import { citedNumbers, dropUnknownCitations, stripCitations } from '../src/agent/citations.js';

describe('citations', () => {
  it('lists cited numbers in first-use order, including grouped markers', () => {
    expect(citedNumbers('Neon is $19 [3]. Supabase is $25 [1, 3][4].')).toEqual([3, 1, 4]);
  });

  it('ignores markdown links', () => {
    expect(citedNumbers('See [2](https://example.com) and [5].')).toEqual([5]);
  });

  it('drops numbers the model was never shown, without leaving a gap', () => {
    const known = new Set([1, 2]);
    expect(dropUnknownCitations('A [1]. B [7]. C [2, 9].', known)).toBe('A [1]. B. C [2].');
  });

  it('strips all markers from past answers', () => {
    expect(stripCitations('Neon costs $19 [3][4], Supabase $25 [1].')).toBe('Neon costs $19, Supabase $25.');
  });
});
