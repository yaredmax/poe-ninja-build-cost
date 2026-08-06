// Checks that a cluster jewel is searched by the notables it grants rather than
// by the filler modifiers listed above them.
//
//   node tools/cluster-test.mjs

const store = new Map();
globalThis.chrome = { storage: { local: {
  async get(k) { return store.has(k) ? { [k]: store.get(k) } : {}; },
  async set(o) { for (const [k, v] of Object.entries(o)) store.set(k, v); } } } };

const UA = 'poe-ninja-build-cost/0.5 (personal build pricing extension)';
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) =>
  realFetch(url, { ...init, headers: { ...(init.headers || {}), 'User-Agent': UA } });

const { loadStatIndex, rolledMods, isClusterJewel } = await import('../src/lib/stats.js');
const { buildComboQuery, fetchPrices, runQuery, webUrl } = await import('../src/lib/trade.js');
const { fetchLeagues } = await import('../src/lib/economy.js');

// Real cluster jewel from the Winter Orb build. Its two notables are listed
// last, behind two resistance grants that every jewel of this base carries.
const JEWEL = {
  name: 'Spirit Curio',
  baseType: 'Medium Cluster Jewel',
  frameType: 2,
  corrupted: false,
  inventoryId: 'PassiveJewels',
  implicitMods: [],
  explicitMods: [
    'Added Small Passive Skills also grant: +2% to Fire Resistance',
    'Added Small Passive Skills also grant: +5% to Lightning Resistance',
    '1 Added Passive Skill is Assert Dominance',
    '1 Added Passive Skill is Magnifier',
  ],
  enchantMods: [
    'Adds 5 Passive Skills',
    '1 Added Passive Skill is a Jewel Socket',
    'Added Small Passive Skills grant: 10% increased Area Damage',
  ],
  craftedMods: [],
  fracturedMods: [],
};

const league = (await fetchLeagues())[0].id;
const index = await loadStatIndex();
const CHAOS_PER_DIV = 187;
const fmt = (c) => (c >= CHAOS_PER_DIV ? `${(c / CHAOS_PER_DIV).toFixed(1)} div` : `${Math.round(c)} c`);

console.log(`League: ${league}`);
console.log(`Recognised as a cluster jewel: ${isClusterJewel(JEWEL)}\n`);

const picked = rolledMods(index, JEWEL, 3);
console.log('Modifiers chosen, notables first:');
for (const m of picked) console.log(`  ${m.id.padEnd(26)} ${m.text}`);

const missed = JEWEL.explicitMods
  .concat(JEWEL.enchantMods)
  .filter((m) => !picked.some((p) => p.text === m));
console.log('Left out:');
for (const m of missed) console.log(`  ${m}`);

const body = buildComboQuery(JEWEL, picked, { minRoll: 80 });
const r = await runQuery(body, league);
const prices = r.total ? await fetchPrices(r.id, r.result, CHAOS_PER_DIV) : [];
const median = prices.length ? prices[Math.floor(prices.length / 2)] : null;
console.log(`\n${r.total} listings   median ${median ? fmt(median) : '—'}`);
console.log(webUrl(league, r.id));
