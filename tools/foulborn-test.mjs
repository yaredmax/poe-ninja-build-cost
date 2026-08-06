// Prices a real Foulborn item end to end.
//
// Allflame's mutation renames the item on poe.ninja but not on trade, and adds
// a modifier that is the whole difference from the plain unique. Both have to be
// handled or the search either 400s or prices the wrong item.
//
//   node tools/foulborn-test.mjs

const store = new Map();
globalThis.chrome = { storage: { local: {
  async get(k) { return store.has(k) ? { [k]: store.get(k) } : {}; },
  async set(o) { for (const [k, v] of Object.entries(o)) store.set(k, v); } } } };

const UA = 'poe-ninja-build-cost/0.5 (personal build pricing extension)';
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) =>
  realFetch(url, { ...init, headers: { ...(init.headers || {}), 'User-Agent': UA } });

const { loadStatIndex, mutatedMods, rolledMods } = await import('../src/lib/stats.js');
const { buildComboQuery, fetchPrices, runQuery, tradeName, webUrl } =
  await import('../src/lib/trade.js');
const { buildPriceIndex, fetchLeagues, normalizeName } = await import('../src/lib/economy.js');

// The wand from the Winter Orb build, at the week-1 snapshot.
const ITEM = {
  name: 'Foulborn Tulfall',
  typeLine: 'Opal Wand',
  baseType: 'Opal Wand',
  frameType: 3,
  inventoryId: 'Weapon',
  corrupted: false,
  mutated: true,
  mutatedMods: ['Gain a Power Charge after Spending a total of 200 Mana'],
  implicitMods: ['35% increased Spell Damage'],
  explicitMods: [
    '20% increased Cast Speed',
    'Adds 54 to 75 Cold Damage to Spells per Power Charge',
    'Lose all Power Charges on reaching Maximum Power Charges',
    'Gain a Frenzy Charge on reaching Maximum Power Charges',
  ],
  craftedMods: [],
  fracturedMods: [],
  enchantMods: [],
};

const league = (await fetchLeagues())[0].id;
const index = await loadStatIndex();
const CHAOS_PER_DIV = 187;
const fmt = (c) => (c >= CHAOS_PER_DIV ? `${(c / CHAOS_PER_DIV).toFixed(1)} div` : `${Math.round(c)} c`);

console.log(`League: ${league}`);
console.log(`poe.ninja calls it: ${ITEM.name}`);
console.log(`trade calls it:     ${tradeName(ITEM)}`);

const { index: prices } = await buildPriceIndex(league);
const economy = prices[normalizeName(ITEM.name)];
console.log(`economy entry found: ${economy ? `${economy.name} — ${fmt(economy.chaos)}` : 'no'}\n`);

const mutation = mutatedMods(index, ITEM);
console.log('mutation mapped:');
for (const m of mutation) console.log(`  ${m.id.padEnd(26)} ${m.text}`);

const rolled = rolledMods(index, ITEM, 3);
const mods = mutation.concat(rolled).slice(0, 3);
console.log('\nfilters, mutation first:');
for (const m of mods) console.log(`  ${m.id.padEnd(26)} ${m.text}`);

const body = buildComboQuery(ITEM, mods, { byName: true, minRoll: 0 });
console.log(`\nquery name: ${JSON.stringify(body.query.name)}`);
console.log(`mutated flag: ${JSON.stringify(body.query.filters.misc_filters.filters.mutated)}`);

const r = await runQuery(body, league);
const listed = r.total ? await fetchPrices(r.id, r.result, CHAOS_PER_DIV) : [];
const median = listed.length ? listed[Math.floor(listed.length / 2)] : null;
console.log(`\n${r.total} listings   median ${median ? fmt(median) : '—'}`);
console.log(webUrl(league, r.id));
