/**
 * Token-bucket rate limiting for the public beacon endpoint.
 *
 * The tracking key is visible in the page source of every site that installs
 * the snippet - it has to be. So anyone can read a key and post traffic with
 * it. Without a limit they could inflate a customer's numbers, poison the
 * attribution data, and through that steer what the planner writes next,
 * because the optimiser feeds on exactly this data.
 *
 * In-process and in-memory on purpose: one server, no Redis, no extra moving
 * part. If this ever runs on more than one instance the limits become
 * per-instance, which is still a bound, just a looser one.
 */

export interface RateLimitOptions {
  /** Maximum burst. */
  capacity: number;
  /** Sustained rate once the burst is spent. */
  refillPerSecond: number;
  /** Hard cap on tracked keys, so the limiter cannot itself be a memory leak. */
  maxEntries?: number;
}

interface Bucket {
  tokens: number;
  updated: number;
}

export class RateLimiter {
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly maxEntries: number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(options: RateLimitOptions) {
    this.capacity = options.capacity;
    this.refillPerSecond = options.refillPerSecond;
    this.maxEntries = options.maxEntries ?? 10_000;
  }

  /**
   * Takes one token. Returns true if the caller may proceed.
   * `now` is injectable so the behaviour can be tested without sleeping.
   */
  take(key: string, now = Date.now()): boolean {
    const bucket = this.buckets.get(key);

    if (!bucket) {
      this.evictIfFull(now);
      this.buckets.set(key, { tokens: this.capacity - 1, updated: now });
      return true;
    }

    // Lazy refill: no timers, no background work.
    const elapsedSeconds = Math.max(0, (now - bucket.updated) / 1000);
    bucket.tokens = Math.min(
      this.capacity,
      bucket.tokens + elapsedSeconds * this.refillPerSecond,
    );
    bucket.updated = now;

    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** Seconds until this key has a token again; 0 when it already does. */
  retryAfter(key: string, now = Date.now()): number {
    const bucket = this.buckets.get(key);
    if (!bucket) return 0;
    const elapsedSeconds = Math.max(0, (now - bucket.updated) / 1000);
    const tokens = Math.min(
      this.capacity,
      bucket.tokens + elapsedSeconds * this.refillPerSecond,
    );
    if (tokens >= 1) return 0;
    return Math.ceil((1 - tokens) / this.refillPerSecond);
  }

  /**
   * Makes room when the map is full.
   *
   * Evicting a bucket hands that key a fresh burst, so the only safe entries
   * to drop are the ones that are already near-full - they were not being
   * constrained anyway. Dropping the oldest or least-recently-seen entry
   * instead would be a bypass: an attacker could flood with throwaway keys to
   * force their own throttled bucket out and start again.
   */
  private evictIfFull(now: number): void {
    if (this.buckets.size < this.maxEntries) return;

    const effective = (bucket: Bucket) =>
      Math.min(
        this.capacity,
        bucket.tokens +
          Math.max(0, (now - bucket.updated) / 1000) * this.refillPerSecond,
      );

    // Fullest first: those have the least to gain from being reset.
    const ranked = [...this.buckets.entries()]
      .map(([key, bucket]) => ({ key, tokens: effective(bucket) }))
      .sort((a, b) => b.tokens - a.tokens);

    const target = Math.max(1, Math.ceil(this.maxEntries / 4));
    for (const { key } of ranked.slice(0, target)) {
      this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }

  reset(): void {
    this.buckets.clear();
  }
}

/**
 * Per-visitor-address limit. A genuine visitor sends a handful of beacons per
 * session, so 60 a minute is far above normal use and well below what is
 * needed to distort a site's figures.
 */
export const ipLimiter = new RateLimiter({
  capacity: 60,
  refillPerSecond: 1,
  maxEntries: 20_000,
});

/**
 * Per-site limit, which is what catches an attack spread across many
 * addresses. 300 a minute sustained is roughly 400k pageviews a day - far
 * more than the kind of business this is built for, and still a ceiling.
 */
export const siteLimiter = new RateLimiter({
  capacity: 600,
  refillPerSecond: 5,
  maxEntries: 5_000,
});
