// Adaptive rate limiting driven by GGG's own response headers.
//
// GGG answers every trade request with the policy it applied and how much of it
// we have already spent:
//
//   x-rate-limit-rules:    Ip
//   x-rate-limit-ip:       5:10:60,15:60:300,30:300:1800,600:21600:3600
//   x-rate-limit-ip-state: 1:10:0,2:60:0,12:300:0,163:21600:0
//
// Each triplet is `hits:period:penalty`. We use the first two and ignore the
// penalty on purpose — it only matters if you exceed the limit, and the whole
// point of this file is never to. That is how Awakened PoE Trade does it too.
//
// Why this beats a fixed delay, which is what this project used before:
//
//  - It is faster. A fixed 5 s gap ignores that the first bucket allows 5
//    requests per 10 s, so short bursts were four times slower than allowed.
//  - It is safer. The buckets are per IP, so the trade website open in another
//    tab spends from the same budget. `-state` tells us the real figure; a fixed
//    delay is blind to it and would happily push us over.

/** Until the server tells us otherwise, assume the worst. */
const PESSIMISTIC = [{ max: 1, window: 5 }];

/**
 * Padding added to every window, in seconds.
 *
 * Our clock and GGG's don't tick together, and a request takes time to arrive.
 * Without the pad a slot can look free here and still be occupied there.
 */
const DESYNC_PAD = 1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One `hits per period` bucket. */
class Bucket {
  constructor(max, windowSeconds) {
    this.max = max;
    this.windowSeconds = windowSeconds;
    this.windowMs = (windowSeconds + DESYNC_PAD) * 1000;
    this.hits = [];
  }

  matches(spec) {
    return this.max === spec.max && this.windowSeconds === spec.window;
  }

  prune(now) {
    const cutoff = now - this.windowMs;
    while (this.hits.length && this.hits[0] <= cutoff) this.hits.shift();
  }

  /** When a slot frees up. `now` if there is room already. */
  freeAt(now) {
    this.prune(now);
    return this.hits.length < this.max ? now : this.hits[0] + this.windowMs;
  }

  consume(now) {
    this.hits.push(now);
  }

  /**
   * Aligns the local count with the server's.
   *
   * If the server counted more requests than we did, somebody else on this IP
   * spent them — the trade site in another tab, most likely. We record them as
   * ours so we don't march straight into a 429.
   */
  syncTo(serverCount, now) {
    this.prune(now);
    for (let i = this.hits.length; i < serverCount; i++) this.hits.push(now);
  }
}

/** Parses the header pair into `{ max, window }` specs plus their used counts. */
function parsePolicy(headers) {
  const rules = headers.get('x-rate-limit-rules');
  if (!rules) return null;

  const specs = [];
  const used = [];
  for (const rule of rules.split(',')) {
    const name = rule.trim().toLowerCase();
    const limit = headers.get(`x-rate-limit-${name}`);
    if (!limit) continue;
    const state = headers.get(`x-rate-limit-${name}-state`) || '';
    const stateParts = state.split(',');

    limit.split(',').forEach((triplet, i) => {
      const [max, window] = triplet.split(':').map(Number);
      if (!Number.isFinite(max) || !Number.isFinite(window)) return;
      specs.push({ max, window });
      used.push(Number(stateParts[i]?.split(':')[0]) || 0);
    });
  }
  return specs.length ? { specs, used } : null;
}

/**
 * One policy's worth of buckets. GGG has a separate policy per endpoint
 * (`trade-search-request-limit`, `trade-fetch-request-limit`), and the fetch one
 * is far more generous, so they get their own limiter each.
 */
export class RateLimiter {
  constructor(name) {
    this.name = name;
    this.buckets = PESSIMISTIC.map((s) => new Bucket(s.max, s.window));
    this.blockedUntil = 0;
    // Serialises callers: without it two concurrent takes could both see the
    // last free slot and use it twice.
    this.chain = Promise.resolve();
  }

  take() {
    const result = this.chain.then(() => this.#take());
    this.chain = result.catch(() => {});
    return result;
  }

  async #take() {
    for (;;) {
      const now = Date.now();
      const readyAt = Math.max(
        this.blockedUntil,
        ...this.buckets.map((b) => b.freeAt(now)),
      );
      if (readyAt <= now) {
        for (const bucket of this.buckets) bucket.consume(now);
        return;
      }
      await sleep(Math.min(readyAt - now, 30_000));
    }
  }

  /** Rebuilds the buckets from a response's headers. */
  sync(headers) {
    const policy = parsePolicy(headers);
    if (!policy) return;
    const now = Date.now();

    this.buckets = policy.specs.map((spec, i) => {
      const bucket = this.buckets.find((b) => b.matches(spec)) || new Bucket(spec.max, spec.window);
      bucket.syncTo(policy.used[i], now);
      return bucket;
    });
  }

  /** Called on a 429: stand down for as long as the server asks. */
  penalise(retryAfterSeconds) {
    const seconds = Number(retryAfterSeconds) || 60;
    this.blockedUntil = Date.now() + seconds * 1000;
  }

  /** Rough seconds needed for `count` more requests, for the UI's estimate. */
  estimate(count) {
    const now = Date.now();
    const sim = this.buckets.map((b) => {
      b.prune(now);
      return { max: b.max, windowMs: b.windowMs, hits: [...b.hits] };
    });

    let clock = now;
    for (let i = 0; i < count; i++) {
      let readyAt = clock;
      for (const b of sim) {
        const live = b.hits.filter((h) => h > clock - b.windowMs);
        if (live.length >= b.max) readyAt = Math.max(readyAt, live[0] + b.windowMs);
      }
      clock = readyAt;
      for (const b of sim) b.hits.push(clock);
    }
    return Math.round((clock - now) / 1000);
  }
}
