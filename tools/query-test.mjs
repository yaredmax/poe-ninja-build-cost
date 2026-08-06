// Shows what the wide query actually asks for, without asking it.
//
// Every other tool here spends GGG's search budget to find out that a query was
// wrong. This one spends none: `/api/trade/data/stats` carries no rate-limit
// headers at all, and poe.ninja's economy API is a different budget entirely, so
// the whole thing runs as often as you like.
//
// What it answers, which the price is too far downstream to tell you:
//
//   - did poe.ninja publish a roll pool for this unique, and did it match?
//   - which of the item's modifiers reached the query, and which were dropped?
//   - do two items that look different produce the same query? (yes, and that is
//     why five different cluster jewels came back at the same price)
//
//   node tools/query-test.mjs              # every fixture item
//   node tools/query-test.mjs Watcher      # by name
//   node tools/query-test.mjs --diff       # only items whose query is a duplicate

import { readFileSync } from 'node:fs';

const store = new Map();
globalThis.chrome = { storage: { local: {
  async get(k) { return store.has(k) ? { [k]: store.get(k) } : {}; },
  async set(o) { for (const [k, v] of Object.entries(o)) store.set(k, v); } } } };

const UA = 'poe-ninja-build-cost/0.5 (personal build pricing extension)';
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) =>
  realFetch(url, { ...init, headers: { ...(init.headers || {}), 'User-Agent': UA } });

const { buildPriceIndex, fetchLeagues, normalizeName } = await import('../src/lib/economy.js');
const {
  GEAR_FIELDS, loadStatIndex, corruptedImplicits, isAnointment, isClusterSocket,
  isCoveredByTotals, isResistanceMod,
  matchMod, modTemplate, mutatedMods, rolledMods, totalElementalResistance,
  totalChaosResistance, wantsLocalStats,
} = await import('../src/lib/stats.js');
const { buildComboQuery, minRollFor } = await import('../src/lib/trade.js');

// The same two numbers background.js uses. Imported by hand because they are not
// exported — the service worker has no reason to, and neither had this until now.
const MAX_COMBO_MODS = 6;
const GEAR_MAX_MODS = 6;

const read = (name) => {
  const data = JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8'));
  return Array.isArray(data) ? data : data.items;
};

const all = [...read('kinds.json'), ...read('worn.json')]
  .filter((i) => i.frameType !== 4 && i.inventoryId);

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const onlyDuplicates = process.argv.includes('--diff');
const items = args.length
  ? all.filter((i) => args.some((a) => `${i.name} ${i.baseType}`.toLowerCase().includes(a.toLowerCase())))
  : all;

const league = (await fetchLeagues())[0].id;
const { index } = await buildPriceIndex(league);
const statIndex = await loadStatIndex();

console.log(`League ${league}   ${items.length} items\n`);

// Which trade prefix each list is searched under. Same pairing stats.js uses;
// see docs/poe-modifiers.md for why the prefix is not cosmetic.
const FIELD_TYPES = [
  ['implicitMods', 'implicit'], ['explicitMods', 'explicit'], ['craftedMods', 'crafted'],
  ['fracturedMods', 'fractured'], ['enchantMods', 'enchant'],
];
const seen = new Map();
const rows = [];

for (const item of items) {
  const label = `${item.name || '(rare)'} ${item.baseType}`.trim();
  const price = index[normalizeName(item.name || '')] || index[normalizeName(label)];
  const isUnique = item.frameType === 3 || item.frameType === 10;
  const isJewel = item.inventoryId === 'PassiveJewels';

  // Exactly what background.js builds, in the same order.
  const corrupted = corruptedImplicits(statIndex, item, price?.implicitPool);
  const mutated = mutatedMods(statIndex, item, price?.basePool);
  const rolled = isUnique || isJewel
    ? rolledMods(statIndex, item, MAX_COMBO_MODS, price?.rollPool)
    : rolledMods(statIndex, item, GEAR_MAX_MODS, null, GEAR_FIELDS);

  const dedupe = new Set();
  const mods = mutated.concat(corrupted, rolled)
    .filter((mod) => !dedupe.has(mod.id) && dedupe.add(mod.id))
    .slice(0, isUnique || isJewel ? MAX_COMBO_MODS : GEAR_MAX_MODS);

  const query = buildComboQuery(item, mods, {
    byName: isUnique,
    minRoll: minRollFor(item, 80),
    useCategory: !isUnique && !isJewel,
    resistance: totalElementalResistance(item),
    chaos: totalChaosResistance(item),
  });

  // Which of the item's own modifier texts never reached the query, and which
  // of four different reasons is why. Lumping them together is how an
  // anointment worth divines looked like a translation failure for an hour:
  // "Allocates Disciple of the Slaughter" resolves perfectly to
  // enchant.stat_2954116742|58921, and was simply pushed out by the cap.
  const local = wantsLocalStats(item);
  const chosen = new Set(mods.map((m) => m.text));
  const dropped = [];
  for (const [field, type] of FIELD_TYPES) {
    for (const text of item[field] || []) {
      if (chosen.has(text)) continue;
      const inPool = price?.rollPool?.length
        ? price.rollPool.includes(modTemplate(text)) : null;
      // Deliberate exclusions first. Whether a modifier we do not want happens
      // to translate is not interesting, and asking that question first is what
      // made "1 Added Passive Skill is a Jewel Socket" — a modifier every
      // medium cluster carries — read as a translation failure.
      const why = isAnointment(text, type) ? 'an anointment, left out on purpose — see stats.js'
        : isClusterSocket(text, item) ? 'a jewel socket, fixed by the cluster size — left out on purpose'
        : !matchMod(statIndex, text, type, local) ? 'NO STAT ID — nothing in trade matches this text'
        : isResistanceMod(text) ? 'the resistance pseudo carries it'
        : local && isCoveredByTotals(text) ? 'a property filter carries it'
        : inPool === false ? 'not in the published roll pool, so every copy has it'
        : 'translated fine, but the six-filter cap cut it';
      dropped.push({ field, text, why });
    }
  }

  const key = JSON.stringify(query?.query ?? null);
  const twin = seen.get(key);
  if (!twin) seen.set(key, label);
  rows.push({ item, label, price, mods, dropped, query, twin, isUnique, isJewel });
}

for (const row of rows) {
  if (onlyDuplicates && !row.twin) continue;
  const { item, label, price, mods, dropped, query, twin } = row;
  const kind = item.kind || item.inventoryId;
  const pool = price?.rollPool?.length ?? 0;

  console.log(`${kind.padEnd(22)} ${label}`);
  console.log(`  roll pool: ${pool ? `${pool} published` : 'none published'}`
    + `   filters: ${query?.query.stats[0].filters.length ?? 0}`);
  for (const mod of mods) console.log(`    + ${mod.id.padEnd(34)} ${mod.text.split('\n')[0]}`);
  for (const d of dropped) {
    console.log(`    - ${`(${d.field.replace('Mods', '')})`.padEnd(34)} ${d.text.split('\n')[0]}  — ${d.why}`);
  }
  if (twin) console.log(`  !! identical query to: ${twin}`);
  console.log('');
}

const duplicates = rows.filter((r) => r.twin);
console.log(`${rows.length} items, ${seen.size} distinct queries`);
if (duplicates.length) {
  console.log(`${duplicates.length} item(s) ask exactly what another item asks, so they cannot`);
  console.log('come back at different prices however many searches they spend:');
  for (const r of duplicates) console.log(`  ${r.label}  ==  ${r.twin}`);
}
