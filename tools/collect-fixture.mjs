// Builds a fixture of one real item of every kind the extension has to price.
//
// The old fixture was captured before items carried their modifiers, so it can
// exercise the name matching and nothing else — background-test.mjs ran the
// whole character through and every single item came back "none of its mods
// could be translated". A pricing pipeline needs items that have mods.
//
// The items come from trade itself, which is the API the extension already
// talks to, and they arrive in GGG's schema — the same schema poe.ninja keeps
// in React and the bridge reads. One search plus one fetch per kind.
//
//   node tools/collect-fixture.mjs          # rewrites tools/fixtures/kinds.json
//
// Run it again when a league ends and the fixture stops resembling the market.
//
// What it cannot collect, by construction: an item that misses the wide query.
// Everything here comes off a listing, so a search for its own modifiers at 80%
// of its own rolls always matches at least the copy it was taken from — one
// search, one fetch, and the fallback ladder never runs. Those items have to be
// worn rather than sold; they live in fixtures/worn.json, which this does not
// touch.

import { writeFileSync } from 'node:fs';

const store = new Map();
globalThis.chrome = { storage: { local: {
  async get(k) { return store.has(k) ? { [k]: store.get(k) } : {}; },
  async set(o) { for (const [k, v] of Object.entries(o)) store.set(k, v); } } } };

const UA = 'poe-ninja-build-cost/0.5 (personal build pricing extension)';
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) =>
  realFetch(url, { ...init, headers: { ...(init.headers || {}), 'User-Agent': UA } });

const { runQuery, fetchLimit } = await import('../src/lib/trade.js');
const { fetchLeagues } = await import('../src/lib/economy.js');

const league = (await fetchLeagues())[0].id;

/**
 * Which slot each category lands in on a character.
 *
 * The pipeline branches on `inventoryId` — jewels take the "search by its own
 * mods" path, everything else the gear path — and a trade listing has no slot,
 * so it has to be supplied here.
 */
const KINDS = [
  { kind: 'rare helm',        slot: 'Helm',       category: 'armour.helmet',  rarity: 'rare' },
  { kind: 'rare body armour', slot: 'BodyArmour', category: 'armour.chest',   rarity: 'rare' },
  { kind: 'rare boots',       slot: 'Boots',      category: 'armour.boots',   rarity: 'rare' },
  { kind: 'rare gloves',      slot: 'Gloves',     category: 'armour.gloves',  rarity: 'rare' },
  { kind: 'rare shield',      slot: 'Offhand',    category: 'armour.shield',  rarity: 'rare' },
  { kind: 'rare ring',        slot: 'Ring',       category: 'accessory.ring', rarity: 'rare' },
  { kind: 'rare amulet',      slot: 'Amulet',     category: 'accessory.amulet', rarity: 'rare' },
  { kind: 'rare belt',        slot: 'Belt',       category: 'accessory.belt', rarity: 'rare' },
  { kind: 'rare wand',        slot: 'Weapon',     category: 'weapon.wand',    rarity: 'rare' },
  { kind: 'rare bow',         slot: 'Weapon',     category: 'weapon.bow',     rarity: 'rare' },
  { kind: 'rare jewel',       slot: 'PassiveJewels', category: 'jewel',       rarity: 'rare' },
  { kind: 'abyss jewel',      slot: 'PassiveJewels', category: 'jewel.abyss', rarity: 'rare' },
  { kind: 'cluster jewel',    slot: 'PassiveJewels', category: 'jewel.cluster', rarity: 'rare' },
  // Uniques whose price depends on the roll, which is the whole reason the
  // combination search exists.
  { kind: 'unique jewel',     slot: 'PassiveJewels', name: "Watcher's Eye" },
  { kind: 'corrupted unique', slot: 'Ring',       name: 'Le Heup of All', corrupted: true },
  { kind: 'foulborn',         slot: 'Weapon',     mutated: true, category: 'weapon.wand' },
  // A plain unique, to prove the simple path still works.
  { kind: 'unique',           slot: 'BodyArmour', name: 'Tabula Rasa' },
];

/**
 * Cheapest-first sampling collects the junk: the ten cheapest rare belts in a
 * league are all "1 alch", and pricing those correctly proves only that the
 * plumbing works. A build wears gear whose modifiers are worth filtering on, so
 * the fixture asks for items somebody actually paid for.
 */
const MIN_CHAOS = 20;

function body(spec) {
  const query = {
    status: { option: 'available' },
    stats: [{ type: 'and', filters: [] }],
    filters: {
      trade_filters: { filters: { price: { min: MIN_CHAOS, option: 'chaos' } } },
    },
  };
  if (spec.name) query.name = spec.name;
  if (spec.category || spec.rarity) {
    query.filters.type_filters = { filters: {} };
    if (spec.category) query.filters.type_filters.filters.category = { option: spec.category };
    if (spec.rarity) query.filters.type_filters.filters.rarity = { option: spec.rarity };
  }
  const misc = {};
  if (spec.corrupted) misc.corrupted = { option: 'true' };
  if (spec.mutated) misc.mutated = { option: 'true' };
  if (Object.keys(misc).length) query.filters.misc_filters = { filters: misc };
  return { query, sort: { price: 'asc' } };
}

/** The raw listings behind a search, rather than just their prices. */
async function fetchItems(queryId, ids) {
  await fetchLimit.take();
  const url = `https://www.pathofexile.com/api/trade/fetch/${ids.slice(0, 10).join(',')}?query=${encodeURIComponent(queryId)}`;
  const res = await fetch(url);
  fetchLimit.sync(res.headers);
  if (!res.ok) throw new Error(`fetch returned ${res.status}`);
  return ((await res.json()).result || []).map((r) => r.item).filter(Boolean);
}

// --------------------------------------------------------------------- slim
// Mirrors `slim()` in src/page-bridge.js. That function cannot be imported: it
// lives inside an IIFE in a MAIN-world content script, and Chrome has no
// declarative module content scripts. tools/check-wiring.mjs compares the two
// field lists so this copy cannot quietly drift from the real one.

const toNumber = (v) => (v == null ? 0 : parseFloat(String(v)) || 0);

function average(range) {
  if (!range) return 0;
  let total = 0;
  for (const part of String(range).split(',')) {
    const [lo, hi] = part.split('-').map(Number);
    total += (lo + (hi ?? lo)) / 2;
  }
  return total;
}

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Trade's mod format, flattened to the one poe.ninja holds.
 *
 * `/fetch` describes each modifier as an object — description, domain, hash,
 * tiers — and files them by where they can appear rather than by what they are:
 * a crafted mod arrives inside `explicitMods` tagged `domain: "crafted"`. The
 * character API that poe.ninja mirrors just gives plain strings in the right
 * array, and that is what the extension reads, so the fixture stores that.
 */
function modLines(item) {
  const out = {
    implicitMods: [], explicitMods: [], craftedMods: [],
    fracturedMods: [], enchantMods: [],
  };
  const field = { implicit: 'implicitMods', explicit: 'explicitMods', crafted: 'craftedMods',
    fractured: 'fracturedMods', enchant: 'enchantMods' };

  for (const [key, fallback] of Object.entries(field)) {
    for (const mod of item[fallback] || []) {
      if (typeof mod === 'string') { out[fallback].push(mod); continue; }
      const domain = mod.flags?.crafted ? 'crafted'
        : mod.flags?.fractured ? 'fractured'
        : mod.domain || key;
      (out[field[domain]] || out[fallback]).push(mod.description ?? String(mod));
    }
  }
  return out;
}

function slim(item, index, slot) {
  const props = {};
  for (const p of item.properties || []) props[p.name] = p.values?.[0]?.[0] ?? null;
  const socketGroups = {};
  for (const s of item.sockets || []) socketGroups[s.group] = (socketGroups[s.group] || 0) + 1;

  return {
    index,
    anchor: null,
    id: item.id || null,
    name: item.name || '',
    typeLine: item.typeLine || '',
    baseType: item.baseType || '',
    frameType: item.frameType,
    support: !!item.support,
    ilvl: item.ilvl ?? null,
    corrupted: !!item.corrupted,
    identified: item.identified !== false,
    inventoryId: slot,
    links: Math.max(0, ...Object.values(socketGroups), 0),
    sockets: (item.sockets || []).length,
    gemLevel: parseInt(props.Level, 10) || null,
    gemQuality: parseInt(String(props.Quality || '').replace('+', ''), 10) || 0,
    defences: {
      ar: parseInt(props.Armour, 10) || 0,
      ev: parseInt(props['Evasion Rating'], 10) || 0,
      es: parseInt(props['Energy Shield'], 10) || 0,
      ward: parseInt(props.Ward, 10) || 0,
      block: parseInt(props['Chance to Block'], 10) || 0,
    },
    weapon: (() => {
      const aps = toNumber(props['Attacks per Second']);
      const pdps = average(props['Physical Damage']) * aps;
      const edps = average(props['Elemental Damage']) * aps;
      return {
        dps: round1(pdps + edps),
        pdps: round1(pdps),
        edps: round1(edps),
        aps: round1(aps),
        crit: round1(toNumber(props['Critical Strike Chance'])),
      };
    })(),
    mutated: !!item.mutated || (item.mutatedMods || []).length > 0,
    mutatedMods: (item.mutatedMods || []).map((m) => (typeof m === 'string' ? m : m.description)),
    ...modLines(item),
  };
}

// ---------------------------------------------------------------------- run

const out = [];
for (const spec of KINDS) {
  process.stdout.write(`${spec.kind.padEnd(18)} `);
  try {
    const r = await runQuery(body(spec), league);
    if (!r.total) { console.log('no listings'); continue; }
    const items = await fetchItems(r.id, r.result);
    // The most-modded one: a rare with two mods tests nothing.
    items.sort((a, b) => (b.explicitMods || []).length - (a.explicitMods || []).length);
    const picked = items[0];
    if (!picked) { console.log('nothing fetched'); continue; }
    const item = slim(picked, out.length, spec.slot);
    item.kind = spec.kind;
    out.push(item);
    console.log(`${(item.name || '(rare)')} ${item.baseType} — ${item.explicitMods.length} explicit`);
  } catch (err) {
    console.log(`failed: ${err.message}`);
  }
}

const path = new URL('fixtures/kinds.json', import.meta.url);
writeFileSync(path, `${JSON.stringify(out, null, 1)}\n`);
console.log(`\n${out.length} items written to tools/fixtures/kinds.json`);
