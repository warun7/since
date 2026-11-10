import type { Source } from '../types.js';
import { canonicalUrl } from './rank.js';

/**
 * Citation numbers that stay put for a whole conversation: [3] names the same page in every
 * answer, so a page seen again keeps its number instead of being renumbered.
 */
export class SourceRegistry {
  private readonly byKey = new Map<string, Source>();
  private readonly touched = new Set<number>();
  private last = 0;

  constructor(existing: Source[] = []) {
    for (const s of existing) {
      this.byKey.set(canonicalUrl(s.url), s);
      this.last = Math.max(this.last, s.n);
    }
  }

  register(s: Omit<Source, 'n'>): Source {
    const key = canonicalUrl(s.url);
    const cur = this.byKey.get(key);
    if (cur) {
      // Passages are the evidence the model cites. An empty re-visit must not erase earlier evidence.
      if (s.passages.length > 0) cur.passages = s.passages;
      cur.title ||= s.title;
      cur.published ??= s.published;
      cur.authority ??= s.authority;
      this.touched.add(cur.n);
      return cur;
    }
    const src: Source = { ...s, n: ++this.last };
    this.byKey.set(key, src);
    this.touched.add(src.n);
    return src;
  }

  get(n: number): Source | undefined {
    return this.all().find((s) => s.n === n);
  }

  byUrl(url: string): Source | undefined {
    return this.byKey.get(canonicalUrl(url));
  }

  all(): Source[] {
    return [...this.byKey.values()].sort((a, b) => a.n - b.n);
  }

  /** Sources registered or updated since this registry was constructed. */
  added(): Source[] {
    return this.all().filter((s) => this.touched.has(s.n));
  }
}
