// Prices a unique whose value is its roll, by trying its modifiers and then
// every combination of one fewer, taking the dearest hit at the first level
// that has a market.
//
//   node tools/variant-test.mjs

const store = new Map();
globalThis.chrome = { storage: { local: {
  async get(k) { return store.has(k) ? { [k]: store.get(k) } : {}; },
  async set(o) { for (const [k, v] of Object.entries(o)) store.set(k, v); } } } };

const UA = 'poe-ninja-build-cost/0.3 (personal build pricing extension)';
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) =>
  realFetch(url, { ...init, headers: { ...(init.headers || {}), 'User-Agent': UA } });

const { buildPriceIndex, fetchLeagues, normalizeName } = await import('../src/lib/economy.js');
const { loadStatIndex, rolledMods } = await import('../src/lib/stats.js');
const { buildComboQuery, combinations, fetchPrices, runQuery, wantsValues, webUrl } =
  await import('../src/lib/trade.js');

// The real Watcher's Eye from the test build. Its first three modifiers are the
// ones every copy has; only the "while affected by" ones are rolled.
const ITEM = {
  name: "Watcher's Eye",
  baseType: 'Prismatic Jewel',
  frameType: 3,
  corrupted: false,
  implicitMods: [],
  explicitMods: [
    '5% increased maximum Energy Shield',
    '6% increased maximum Life',
    '5% increased maximum Mana',
    '14% increased Attack Speed while affected by Precision',
    '10% of Damage taken from Mana before Life while affected by Clarity',
    '+12% chance to Suppress Spell Damage while affected by Grace',
  ],
};

const league = (await fetchLeagues())[0].id;
const { index, chaosPerDivine } = await buildPriceIndex(league);
const statIndex = await loadStatIndex();
const entry = index[normalizeName(ITEM.name)];
const fmt = (c) =>
  c >= chaosPerDivine ? `${(c / chaosPerDivine).toFixed(1)} div` : `${Math.round(c)} c`;

const mods = rolledMods(statIndex, ITEM, 3, entry.rollPool);
console.log(`League: ${league}`);
console.log(`poe.ninja floor: ${fmt(entry.chaos)}   roll pool: ${entry.rollPool?.length ?? 0} mods`);
console.log(`values in filters: ${wantsValues(ITEM)}\n`);
console.log('Rolled mods used:');
for (const m of mods) console.log(`  ${m.text}`);

const started = Date.now();
let queries = 0;

for (let size = mods.length; size >= 1; size--) {
  console.log(`\n--- ${size} mod(s) at a time`);
  const hits = [];
  for (const combo of combinations(mods, size)) {
    const query = buildComboQuery(ITEM, combo, { byName: true, withValues: wantsValues(ITEM) });
    queries++;
    const r = await runQuery(query, league);
    const label = combo.map((m) => m.text.slice(0, 34)).join('  +  ');
    console.log(`   ${String(r.total).padStart(4)} listings   ${label}`);
    if (r.total > 0) hits.push({ ...r, combo });
  }
  if (!hits.length) continue;

  let best = null;
  for (const hit of hits) {
    const prices = await fetchPrices(hit.id, hit.result, chaosPerDivine);
    const median = prices.length ? prices[Math.floor(prices.length / 2)] : null;
    if (median != null && (!best || median > best.median)) best = { ...hit, median };
  }
  if (best) {
    console.log(`\n=> ${fmt(best.median)}   (dearest of ${hits.length} combination(s) at this level)`);
    console.log(`   poe.ninja floor was ${fmt(entry.chaos)}`);
    console.log(`   ${webUrl(league, best.id)}`);
    break;
  }
}

console.log(`\n${queries} searches, ${((Date.now() - started) / 1000).toFixed(1)} s`);
