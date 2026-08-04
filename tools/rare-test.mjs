// Appraises a build's real rares against the actual trade API.
// Up to three requests per item (search, optional retries, fetch) spaced 5 s
// apart: with 7 rares that's under two minutes, well inside GGG's limits.
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

const { loadStatIndex, significantMods, totalElementalResistance, totalLife, matchMod, MOD_FIELDS } =
  await import('../src/lib/stats.js');
const { buildRareQuery, runQuery, fetchPrices, reliability, RELIABLE, isBetter, attemptPlan } =
  await import('../src/lib/trade.js');
const { fetchLeagues } = await import('../src/lib/economy.js');

const INITIAL_MODS = 2;
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
if (unmatched.length) {
  console.log('  unmatched:');
  for (const u of unmatched) console.log(`    ${u}`);
}

// 2) the real appraisal
console.log(`\nLeague: ${league}\n`);
const fmt = (c) =>
  c >= CHAOS_PER_DIV ? `${(c / CHAOS_PER_DIV).toFixed(1)} div` : `${Math.round(c)} c`;
let sum = 0;
let counted = 0;

for (const item of rares) {
  const helpers = { significantMods, totalElementalResistance, totalLife };
  let body = buildRareQuery(item, index, helpers, INITIAL_MODS);
  const header = `${item.name} [${item.baseType}]`;
  if (!body) { console.log(`  ${header}: no filterable mods`); continue; }

  try {
    let { id, result, total } = await runQuery(body, league);
    let adjusted = false;
    let width = body.query.stats[0].filters.length;
    for (const n of attemptPlan(total, INITIAL_MODS)) {
      if (RELIABLE.has(reliability(total))) break;
      const other = buildRareQuery(item, index, helpers, n);
      if (!other || other.query.stats[0].filters.length === width) continue;
      width = other.query.stats[0].filters.length;
      const attempt = await runQuery(other, league);
      if (isBetter(attempt.total, total)) {
        adjusted = true;
        body = other;
        ({ id, result, total } = attempt);
      }
    }

    const prices = total ? await fetchPrices(id, result, CHAOS_PER_DIV) : [];
    const median = prices.length ? prices[Math.floor(prices.length / 2)] : null;
    const rating = reliability(total);
    const counts = RELIABLE.has(rating) && median;
    if (counts) { sum += median; counted++; }

    console.log(
      `  ${header.padEnd(42)} ${String(total).padStart(5)} res` +
      `  ~ ${(median ? fmt(median) : '—').padStart(9)}` +
      `  reliability=${rating.padEnd(7)}${counts ? 'COUNTED' : 'discarded'}` +
      `${adjusted ? ' (adjusted)' : ''}`,
    );
    console.log(`      filters: ${body.query.stats[0].filters.map((f) => f.id).join(', ')}`);
  } catch (err) {
    console.log(`  ${header}: ERROR ${err.message}`);
  }
}

console.log(`\nRares with a reliable appraisal: ${counted}/${rares.length}   adding up to ${fmt(sum)}`);
