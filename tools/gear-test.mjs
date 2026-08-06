// Checks the query built for a real rare body armour: local defence stats,
// resistances folded into one pseudo, and how many listings it actually finds.
//
//   node tools/gear-test.mjs

const store = new Map();
globalThis.chrome = { storage: { local: {
  async get(k) { return store.has(k) ? { [k]: store.get(k) } : {}; },
  async set(o) { for (const [k, v] of Object.entries(o)) store.set(k, v); } } } };

const UA = 'poe-ninja-build-cost/0.5 (personal build pricing extension)';
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) =>
  realFetch(url, { ...init, headers: { ...(init.headers || {}), 'User-Agent': UA } });

const { GEAR_FIELDS, loadStatIndex, rolledMods, totalElementalResistance, wantsLocalStats } =
  await import('../src/lib/stats.js');
const { buildOwnModsQuery, fetchPrices, runQuery, webUrl } = await import('../src/lib/trade.js');
const { fetchLeagues } = await import('../src/lib/economy.js');

// The chest from the Winter Orb build that came back with nothing.
const ITEM = {
  name: 'Foe Veil',
  baseType: 'Twilight Regalia',
  frameType: 2,
  corrupted: false,
  inventoryId: 'BodyArmour',
  implicitMods: [
    '11% of Physical Damage from Hits taken as Chaos Damage',
    '+25% to Critical Strike Multiplier for Spell Damage',
  ],
  explicitMods: [
    '+93 to maximum Energy Shield',
    '136% increased Energy Shield',
    '+46% to Fire Resistance',
    '+43% to Lightning Resistance',
    '18% increased Stun and Block Recovery',
  ],
  craftedMods: ['+20% to Fire and Lightning Resistances'],
  fracturedMods: [],
  enchantMods: ['8% increased Explicit Defence Modifier magnitudes'],
  defences: { ar: 0, ev: 0, es: 1119, ward: 0 },
};

const league = (await fetchLeagues())[0].id;
const index = await loadStatIndex();
const CHAOS_PER_DIV = 187;
const fmt = (c) => (c >= CHAOS_PER_DIV ? `${(c / CHAOS_PER_DIV).toFixed(1)} div` : `${Math.round(c)} c`);

console.log(`League: ${league}`);
console.log(`Local stats for this slot: ${wantsLocalStats(ITEM)}`);
console.log(`Total elemental resistance: ${totalElementalResistance(ITEM)}%\n`);

const picked = rolledMods(index, ITEM, 3, null, GEAR_FIELDS);
console.log('Modifiers chosen (resistances excluded, they become the pseudo):');
for (const m of picked) console.log(`  ${m.id.padEnd(26)} ${m.text}`);

for (const minRoll of [80, 0]) {
  const body = buildOwnModsQuery(ITEM, index, { rolledMods, totalElementalResistance }, {
    maxMods: 3, fields: GEAR_FIELDS, useCategory: true, minRoll,
  });
  const filters = body.query.stats[0].filters;
  const r = await runQuery(body, league);
  const prices = r.total ? await fetchPrices(r.id, r.result, CHAOS_PER_DIV) : [];
  const median = prices.length ? prices[Math.floor(prices.length / 2)] : null;
  console.log(`\nmin roll ${String(minRoll).padStart(3)}%  ->  ${String(r.total).padStart(5)} listings   median ${median ? fmt(median) : '—'}`);
  for (const f of filters) console.log(`     ${f.id}${f.value ? ` >= ${f.value.min}` : ''}`);
  const armour = body.query.filters.armour_filters?.filters;
  for (const [k, v] of Object.entries(armour || {})) {
    console.log(`     armour_filters.${k}${v.min ? ` >= ${v.min}` : ''}`);
  }
  console.log(`     ${webUrl(league, r.id)}`);
}
