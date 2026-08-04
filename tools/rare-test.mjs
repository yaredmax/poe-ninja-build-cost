// Appraises a build's real rare gear against the actual trade API, using the
// same two strategies the extension does, and reports which one won.
//
//   node tools/rare-test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const store = new Map();
globalThis.chrome = { storage: { local: {
  async get(k) { return store.has(k) ? { [k]: store.get(k) } : {}; },
  async set(o) { for (const [k, v] of Object.entries(o)) store.set(k, v); } } } };

// In the extension the User-Agent is set by the declarativeNetRequest rule.
// Here we set it by hand: without it Cloudflare answers 403. ASCII only.
const UA = 'poe-ninja-build-cost/0.3 (personal build pricing extension)';
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) =>
  realFetch(url, { ...init, headers: { ...(init.headers || {}), 'User-Agent': UA } });

const {
  GEAR_FIELDS, loadStatIndex, matchMod, MOD_FIELDS,
  rolledMods, significantMods, totalElementalResistance, totalLife,
} = await import('../src/lib/stats.js');
const {
  buildOwnModsQuery, buildRareQuery, fetchPrices, isBetter, reliability, RELIABLE, runQuery,
} = await import('../src/lib/trade.js');
const { fetchLeagues } = await import('../src/lib/economy.js');

const FALLBACK_MODS = 1;
const GEAR_MOD_STEPS = [3, 2];
const rares = JSON.parse(readFileSync(join(here, 'fixtures', 'character-rares.json'), 'utf8')).items;
const league = (await fetchLeagues())[0].id;
const CHAOS_PER_DIV = 187;

const index = await loadStatIndex();

// 1) coverage of the mod-text -> stat id mapping
let ok = 0, fail = 0;
const unmatched = [];
for (const item of rares) {
  for (const [field, type] of MOD_FIELDS) {
    for (const mod of item[field] || []) {
      if (matchMod(index, mod, type)) ok++;
      else { fail++; unmatched.push(`${type}: ${mod}`); }
    }
  }
}
console.log(`Mod mapping: ${ok}/${ok + fail}`);
for (const u of unmatched) console.log(`  unmatched  ${u}`);

// 2) the real appraisal, mirroring src/background.js
console.log(`\nLeague: ${league}\n`);
const fmt = (c) =>
  c >= CHAOS_PER_DIV ? `${(c / CHAOS_PER_DIV).toFixed(1)} div` : `${Math.round(c)} c`;
let sum = 0;
let counted = 0;
const startedAt = Date.now();
const helpers = { significantMods, totalElementalResistance, totalLife };

for (const item of rares) {
  const header = `${item.name} [${item.baseType}]`;
  let best = null;
  const consider = (attempt, body, strategy) => {
    if (!best || isBetter(attempt.total, best.total)) best = { ...attempt, body, strategy };
  };

  try {
    let width = -1;
    for (const n of GEAR_MOD_STEPS) {
      const query = buildOwnModsQuery(item, index, { rolledMods }, {
        maxMods: n, fields: GEAR_FIELDS, useCategory: true,
      });
      if (!query) continue;
      const filters = query.query.stats[0].filters.length;
      if (filters === width) continue;
      width = filters;
      consider(await runQuery(query, league), query, 'own-mods');
      if (RELIABLE.has(reliability(best.total))) break;
    }

    if (!best || !RELIABLE.has(reliability(best.total))) {
      const query = buildRareQuery(item, index, helpers, FALLBACK_MODS);
      if (query) consider(await runQuery(query, league), query, 'pseudo');
    }

    if (!best) { console.log(`  ${header}: no filterable mods`); continue; }

    const prices = best.total ? await fetchPrices(best.id, best.result, CHAOS_PER_DIV) : [];
    const median = prices.length ? prices[Math.floor(prices.length / 2)] : null;
    const rating = reliability(best.total);
    // Same gate as src/background.js: an own-mods search is precise, so a
    // single listing is a real answer rather than a fluke.
    const counts =
      (best.strategy === 'own-mods' ? best.total > 0 : RELIABLE.has(rating)) && median;
    if (counts) { sum += median; counted++; }

    console.log(
      `  ${header.padEnd(42)} ${String(best.total).padStart(5)} res` +
      `  ~ ${(median ? fmt(median) : '—').padStart(9)}` +
      `  ${rating.padEnd(7)} ${(counts ? 'COUNTED' : 'discarded').padEnd(10)} via ${best.strategy}`,
    );
  } catch (err) {
    console.log(`  ${header}: ERROR ${err.message}`);
  }
}

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`\nElapsed: ${elapsed} s for ${rares.length} items`);
console.log(`Rares with a reliable appraisal: ${counted}/${rares.length}   adding up to ${fmt(sum)}`);
