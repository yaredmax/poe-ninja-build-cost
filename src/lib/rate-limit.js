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

/**
 * Share of each bucket left untouched, for the user's own trade searches.
 *
 * The buckets are per IP, so this extension and the trade site the player has
 * open are spending the same allowance. Filling it means their manual search
 * gets the 429 — which is exactly what happened: a build was being priced, the
 * player searched something themselves, and both got blocked for two minutes.
 * At least one slot always stays free, even on the small buckets where a share
 * would round down to nothing.
 *
 * **A sixth, not a third.** Simulated with `estimate()` below, over the real
 * policies, for the 46 searches a measured pass actually sent:
 *
 *   reserve   10s  60s  300s     46 searches
 *   1/3         3   10    20        10:13
 *   1/6         4   12    25         6:24
 *   1/12        4   13    27         6:13
 *   none        4   14    29         6:02
 *
 * Nearly four minutes for the first step and twenty seconds for everything
 * after it: past the opening burst the pace is set by the 300 s bucket, and 25
 * usable against 29 barely moves it. So a sixth takes the whole win and still
 * leaves the player five searches every five minutes, which is a person
 * browsing rather than a person locked out.
 *
 * The fetch policy has a cliff rather than a curve — 42 fetches against 41
 * usable at a sixth costs five minutes, against 45 at a twelfth costs thirty
 * seconds — but tuning a reserve to sit just under a cliff is not a fix, it is
 * a coincidence that the next build undoes. The fix is fetching less; see
 * docs/ideas.md.
 */
const USER_RESERVE = 1 / 6;

/** One `hits per period` bucket. */
class Bucket {
  constructor(max, windowSeconds) {
    this.max = max;
    // Never take the whole bucket. At least one slot stays free even on the
    // small ones, where a third would round down to nothing.
    this.usable = Math.max(1, max - Math.max(1, Math.ceil(max * USER_RESERVE)));
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
    return this.hits.length < this.usable ? now : this.hits[0] + this.windowMs;
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
    // Total time callers have spent held here. The pass is slow either because
    // GGG is slow or because we are holding requests back, and those are
    // opposite problems with opposite fixes — so they are counted apart.
    this.waitedMs = 0;
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
    const enteredAt = Date.now();
    for (;;) {
      const now = Date.now();
      const readyAt = Math.max(
        this.blockedUntil,
        ...this.buckets.map((b) => b.freeAt(now)),
      );
      if (readyAt <= now) {
        for (const bucket of this.buckets) bucket.consume(now);
        this.waitedMs += now - enteredAt;
        return;
      }
      await sleep(Math.min(readyAt - now, 30_000));
    }
  }

  /**
   * What the limiter believes right now, for the debug report.
   *
   * `usable` is the part of each bucket we let ourselves have; the rest is held
   * back for the player's own trade searches. If a report shows a bucket at its
   * usable limit with the server's own count far below, the wait is ours and
   * not GGG's.
   */
  state() {
    const now = Date.now();
    return this.buckets.map((b) => {
      b.prune(now);
      return {
        max: b.max, usable: b.usable, windowSeconds: b.windowSeconds, spent: b.hits.length,
      };
    });
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
      return { usable: b.usable, windowMs: b.windowMs, hits: [...b.hits] };
    });

    let clock = now;
    for (let i = 0; i < count; i++) {
      let readyAt = clock;
      for (const b of sim) {
        const live = b.hits.filter((h) => h > clock - b.windowMs);
        if (live.length >= b.usable) readyAt = Math.max(readyAt, live[0] + b.windowMs);
      }
      clock = readyAt;
      for (const b of sim) b.hits.push(clock);
    }
    return Math.round((clock - now) / 1000);
  }
}
