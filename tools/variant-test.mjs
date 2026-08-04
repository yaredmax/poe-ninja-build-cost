// Checks that a unique whose price depends on its roll gets searched by the
// mods it actually has, instead of by name alone.
//
// The item below is the real Watcher's Eye from the test build. Its first three
// modifiers are the ones every copy has; only the "while affected by" ones are
// rolled, and those are what it is worth.
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
const { buildVariantQuery, runQuery, fetchPrices } = await import('../src/lib/trade.js');

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

console.log(`League: ${league}`);
console.log(`poe.ninja floor price: ${fmt(entry.chaos)}  (floor=${entry.floor})`);
console.log(`Roll pool size: ${entry.rollPool?.length ?? 0} modifiers\n`);

// Which of the item's mods count as rolled rather than always-present
const picked = rolledMods(statIndex, ITEM, 3, entry.rollPool);
console.log('Mods chosen for the search:');
for (const m of picked) console.log(`  ${m.text}`);
const ignored = ITEM.explicitMods.filter((m) => !picked.some((p) => p.text === m));
console.log('Ignored (every copy has them):');
for (const m of ignored) console.log(`  ${m}`);

// How restrictive can we be and still find a market? Demanding all three rolled
// mods at once describes an almost unique item, so we step down.
console.log(`\npoe.ninja floor: ${fmt(entry.chaos)}\n`);
for (const n of [3, 2, 1]) {
  const body = buildVariantQuery(ITEM, statIndex, { rolledMods }, entry.rollPool, n);
  if (!body) { console.log(`  ${n} mod(s): no query`); continue; }
  const { id, result, total } = await runQuery(body, league);
  const prices = total ? await fetchPrices(id, result, chaosPerDivine) : [];
  const median = prices.length ? prices[Math.floor(prices.length / 2)] : null;
  console.log(
    `  ${n} mod(s): ${String(total).padStart(4)} listings   median ${(median ? fmt(median) : '—').padStart(9)}` +
    `   https://www.pathofexile.com/trade/search/${encodeURIComponent(league)}/${id}`,
  );
}
