/**
 * Small LRU with expiry. Map keeps insertion order, so re-inserting on read moves an entry to
 * the back and the first key is always the least recently used.
 */
export class TTLCache<V> {
  private readonly items = new Map<string, { value: V; expires: number }>();
  private readonly max: number;
  private readonly ttlMs: number;

  constructor(max = 200, ttlMs = 15 * 60_000) {
    this.max = max;
    this.ttlMs = ttlMs;
  }

  get(key: string): V | undefined {
    const hit = this.items.get(key);
    if (!hit) return undefined;
    this.items.delete(key);
    if (hit.expires <= Date.now()) return undefined;
    this.items.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V): void {
    this.items.delete(key);
    this.items.set(key, { value, expires: Date.now() + this.ttlMs });
    if (this.items.size > this.max) {
      const oldest = this.items.keys().next().value;
      if (oldest !== undefined) this.items.delete(oldest);
    }
  }
}
