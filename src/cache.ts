// In-process TTL cache. Single Bun process, so a plain Map is enough — no KV/Durable Object needed.
// Keyed on the full request URL. Eviction is lazy: a stale entry is only removed when read.

interface Entry {
  value: unknown;
  fetchedAt: string;
  expiresAt: number;
}

export interface Cached<T> {
  value: T;
  // When the upstream fetch actually happened — not when the cache was read. The model
  // relies on this to judge staleness, so a HIT must never report a fresh timestamp.
  fetchedAt: string;
}

const DEFAULT_TTL_MS = 45_000;

// The cache key is the full request URL, which carries the app_key query param. Never
// log that verbatim — redact it so the key doesn't end up in terminal history/log files.
function redact(url: string): string {
  return url.replace(/([?&]app_key=)[^&]+/, "$1REDACTED");
}

export class TtlCache {
  private readonly store = new Map<string, Entry>();

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  get<T>(key: string): Cached<T> | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      console.log(`[cache] MISS ${redact(key)}`);
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      console.log(`[cache] MISS (expired) ${redact(key)}`);
      return undefined;
    }
    console.log(`[cache] HIT ${redact(key)}`);
    return { value: entry.value as T, fetchedAt: entry.fetchedAt };
  }

  set<T>(key: string, value: T): Cached<T> {
    const fetchedAt = new Date().toISOString();
    this.store.set(key, { value, fetchedAt, expiresAt: Date.now() + this.ttlMs });
    return { value, fetchedAt };
  }
}

export const tflCache = new TtlCache();
// Departure boards and crowding refresh every ~20s on the page; 45s would freeze them.
export const liveCache = new TtlCache(15_000);
