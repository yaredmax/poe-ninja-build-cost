// Rate-limit state shared between tool runs.
//
// Every tool starts a fresh node process with a fresh RateLimiter, which knows
// nothing until its first response comes back — so its first request goes out
// blind. One tool doing that is fine. A dozen probes in an afternoon is how you
// collect a 1800-second penalty on the 30-per-300s bucket, and the buckets are
// per IP, so the person whose machine it is loses the trade site too.
//
// The extension does not have this problem: one service worker, one limiter,
// alive for the whole run. This gives the tools the same continuity by parking
// the buckets in a file between runs.
//
//   import { restoreLimits, persistLimits } from './lib/shared-limits.mjs';
//   await restoreLimits();          // before the first request
//   process.on('exit', persistLimits);

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = new URL('../.limits.json', import.meta.url);
const path = fileURLToPath(FILE);

/** Only the hits matter; the shapes come back from the next response's headers. */
export async function restoreLimits() {
  const { searchLimit, fetchLimit } = await import('../../src/lib/trade.js');
  let saved;
  try {
    saved = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return; // first run, or the file was cleared on purpose
  }

  for (const [limiter, name] of [[searchLimit, 'search'], [fetchLimit, 'fetch']]) {
    const hits = saved[name] || [];
    if (!hits.length) continue;
    // Replay them into whatever buckets exist. They are pruned by age on the
    // next take(), so anything older than its window costs nothing.
    for (const bucket of limiter.buckets) bucket.hits = [...hits];
  }
}

export function persistLimits() {
  // Imported synchronously by the caller's exit handler, so read from the
  // module cache rather than awaiting a fresh import.
  const trade = globalThis.__pncTradeModule;
  if (!trade) return;
  const now = Date.now();
  const out = {};
  for (const [limiter, name] of [[trade.searchLimit, 'search'], [trade.fetchLimit, 'fetch']]) {
    // The widest bucket holds the longest memory, so keep that one's hits.
    const widest = limiter.buckets.reduce(
      (a, b) => (b.windowMs > (a?.windowMs ?? 0) ? b : a),
      null,
    );
    out[name] = (widest?.hits || []).filter((h) => h > now - (widest?.windowMs || 0));
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(out));
  } catch {
    // Losing the file only costs us the head start next time.
  }
}

/** Call once after importing trade.js, so `persistLimits` can reach it on exit. */
export async function trackLimits() {
  globalThis.__pncTradeModule = await import('../../src/lib/trade.js');
  process.on('exit', persistLimits);
}
