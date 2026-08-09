// Exercises `priceForItem` with the real items the bridge harvests from a build.
// The fixture came from running the src/page-bridge.js harvest on
// poe1/builds/allflame/character/pathofky-0288/Ky_BladeBUSTIN.
//
//   node tools/price-test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const store = new Map();
globalThis.chrome = { storage: { local: {
  async get(k) { return store.has(k) ? { [k]: store.get(k) } : {}; },
  async set(o) { for (const [k, v] of Object.entries(o)) store.set(k, v); } } } };

const { buildPriceIndex, fetchLeagues, normalizeName } = await import('../src/lib/economy.js');
const items = JSON.parse(readFileSync(join(here, 'fixtures', 'character-items.json'), 'utf8')).items;

const league = (await fetchLeagues())[0].id;
const { index, chaosPerDivine } = await buildPriceIndex(league);

// mirror of priceForItem() in src/content.js
const isUnique = (i) => i.frameType === 3 || i.frameType === 10;
const isGem = (i) => i.frameType === 4;

function priceForItem(item) {
  const entry = index[normalizeName(isGem(item) ? item.baseType : item.name)];
  if (!entry) return null;
  if (isGem(item) && entry.gems?.length) {
    const exact = entry.gems.find(
      ([l, q, c]) => l === item.gemLevel && q === item.gemQuality && c === (item.corrupted ? 1 : 0));
    const sameLevel = entry.gems.filter(([l]) => l === item.gemLevel);
    const hit = exact || sameLevel[0];
    if (hit) return { ...entry, chaos: hit[3], detail: `${item.gemLevel}/${item.gemQuality}` };
    return entry;
  }
  if (isUnique(item) && entry.uniq?.length) {
    const corrupted = item.corrupted ? 1 : 0;
    const exact = entry.uniq.find(([l, c]) => l === item.links && c === corrupted);
    const sameLinks = entry.uniq.filter(([l]) => l === item.links);
    const hit = exact || sameLinks[0];
    if (hit) return { ...entry, chaos: hit[2], detail: item.links >= 5 ? `${item.links}L` : null };
  }
  return entry;
}

// mirror of categoryOf() in src/content.js
const EQUIPMENT_SLOTS = new Set(['Helm', 'BodyArmour', 'Boots', 'Gloves', 'Weapon',
  'Weapon2', 'Offhand', 'Offhand2', 'Ring', 'Ring2', 'Amulet', 'Belt', 'Trinket']);
function categoryOf(item) {
  if (isGem(item)) return 'Gems';
  if (item.inventoryId === 'Flask') return 'Flasks';
  if (item.inventoryId === 'PassiveJewels') return 'Jewels';
  if (EQUIPMENT_SLOTS.has(item.inventoryId)) return 'Equipment';
  return 'Other';
}

const fmt = (c) =>
  c >= chaosPerDivine ? `${(c / chaosPerDivine).toFixed(1)} div` : `${Math.round(c)} c`;
const label = (i) => i.name || i.baseType;

console.log(`League: ${league}   1 div ~ ${Math.round(chaosPerDivine)} c   items: ${items.length}\n`);

let total = 0;
const noPrice = [];
const rows = [];
for (const item of items) {
  const p = priceForItem(item);
  if (!p) { noPrice.push(item); continue; }
  total += p.chaos || 0;
  rows.push({ item, p });
}

console.log(`TOTAL: ${fmt(total)}  (${rows.length} priced, ${noPrice.length} without a price)\n`);

const groups = new Map();
for (const r of rows) {
  const c = categoryOf(r.item);
  if (!groups.has(c)) groups.set(c, []);
  groups.get(c).push(r);
}

const sections = [...groups.entries()]
  .map(([name, items]) => {
    // same duplicate merging the panel does
    const merged = new Map();
    for (const { item, p } of items) {
      const detail = p.detail ? ` (${p.detail})` : '';
      const key = `${label(item)}${detail}|${p.floor}|${p.chaos}`;
      const prev = merged.get(key);
      if (prev) { prev.count++; prev.chaos += p.chaos; }
      else merged.set(key, { name: label(item) + detail, floor: p.floor, chaos: p.chaos, count: 1 });
    }
    const list = [...merged.values()].sort((a, b) => b.chaos - a.chaos);
    return {
      name, list,
      units: list.reduce((s, f) => s + f.count, 0),
      subtotal: list.reduce((s, f) => s + f.chaos, 0),
    };
  })
  .sort((a, b) => b.subtotal - a.subtotal);

for (const s of sections) {
  console.log(`${s.name.toUpperCase()} (${s.units})`.padEnd(44) + fmt(s.subtotal).padStart(10));
  for (const f of s.list) {
    const text = f.name + (f.count > 1 ? ` x${f.count}` : '');
    console.log(`  ${f.floor ? '>=' : '  '} ${text.padEnd(38)} ${fmt(f.chaos).padStart(10)}`);
  }
  console.log('');
}

// Same split the panel makes: an unpriced unique is not the same as a rare.
const unpriced = noPrice.filter((i) => isUnique(i));
const random = noPrice.filter((i) => !isUnique(i));

console.log(`UNPRICED (${unpriced.length})`.padEnd(44) + '—'.padStart(10));
for (const i of unpriced) console.log(`     ${label(i)} [${i.baseType}]`);

console.log(`\nRare/magic without a price (${random.length}):`);
for (const i of random) console.log(`     ${label(i)} [${i.baseType}]`);
