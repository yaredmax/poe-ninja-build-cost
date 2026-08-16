// Impossible Escape and Eyes of the Greatwolf, as poe.ninja/poe1/pob/974c8
// harvests them after the PoB wrap is joined.
//
//   node tools/unique-mod-test.mjs

const store = new Map();
globalThis.chrome = { storage: { local: {
  async get(k) { return store.has(k) ? { [k]: store.get(k) } : {}; },
  async set(o) { for (const [k, v] of Object.entries(o)) store.set(k, v); } } } };

const UA = 'poe-ninja-build-cost/0.6.0 (+https://github.com/yaredmax/poe-ninja-build-cost)';
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) =>
  realFetch(url, { ...init, headers: { ...(init.headers || {}), 'User-Agent': UA } });

const { joinWrappedMods, stripPobHeaders } = await import('../src/lib/pob-item.js');
const { loadStatIndex, matchMod, rolledMods, isFlexUniqueMod } = await import('../src/lib/stats.js');
const { buildComboQuery } = await import('../src/lib/trade.js');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ok   ' : '  FAIL '}${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const index = await loadStatIndex();

const escapeText = joinWrappedMods(stripPobHeaders([
  'Radius: Small',
  'Limited to: 1',
  'Passive Skills in Radius of Chaos Inoculation can be Allocated',
  'without being connected to your tree',
  'Passage',
]))[0];
const keystone = matchMod(index, escapeText, 'explicit');
check(
  keystone?.id === 'explicit.stat_2422708892|11455',
  'Chaos Inoculation Impossible Escape is the option stat, not untranslatable',
  keystone?.id,
);

const wolf = {
  name: 'Eyes of the Greatwolf',
  baseType: 'Greatwolf Talisman',
  frameType: 3,
  inventoryId: 'Amulet',
  corrupted: false,
  implicitMods: [],
  explicitMods: ['100% increased Enchantment Modifier magnitudes'],
  enchantMods: [
    '+8% to maximum Lightning Resistance',
    '+2 to maximum number of Spectres',
  ],
  craftedMods: [],
  fracturedMods: [],
};
const rolled = rolledMods(index, wolf, 6, null);
const ids = rolled.map((m) => m.id);
check(
  ids.includes('explicit.stat_2636298851') && rolled.find((m) => m.id.endsWith('stat_2636298851'))?.values[0] === 100,
  'Greatwolf keeps the 100% enchantment-magnitude roll',
);
check(
  ids.includes('implicit.stat_1011760251'),
  'max lightning resistance is searched as an implicit, the slot trade lists',
  ids.filter((id) => id.includes('1011760251')).join(',') || 'missing',
);
check(
  ids.includes('enchant.stat_125218179') || ids.includes('explicit.stat_125218179'),
  '+2 Spectres reaches the query',
  ids.filter((id) => id.includes('125218179')).join(',') || 'missing',
);

const flex = rolled.filter((m) => isFlexUniqueMod(m, wolf, []));
const fixed = rolled.filter((m) => !flex.includes(m));
check(flex.length === 2, 'the two beast mods are the count group', String(flex.length));
check(
  fixed.length === 1 && fixed[0].id === 'explicit.stat_2636298851',
  'the 100% magnitude stays in and, not in the count',
);

const both = buildComboQuery(wolf, fixed, { byName: true, minRoll: 100, countMods: flex, countMin: 2 });
const either = buildComboQuery(wolf, fixed, { byName: true, minRoll: 100, countMods: flex, countMin: 1 });
const groups = (body) => body?.query?.stats || [];
check(
  groups(both).some((g) => g.type === 'count' && g.value?.min === 2 && g.filters?.length === 2),
  'first search is count min 2 of the two extras',
);
check(
  groups(either).some((g) => g.type === 'count' && g.value?.min === 1 && g.filters?.length === 2),
  'fallback is count min 1 of the same two',
);
check(
  groups(both).some((g) => g.type === 'and' && g.filters?.some((f) => f.id === 'explicit.stat_2636298851' && f.value?.min === 100)),
  'both searches still pin the 100% magnitude',
);
check(both.query.name === 'Eyes of the Greatwolf', 'the unique is still searched by name');

console.log(failures ? `\n${failures} case(s) wrong` : '\nall resolved');
process.exitCode = failures ? 1 : 0;
