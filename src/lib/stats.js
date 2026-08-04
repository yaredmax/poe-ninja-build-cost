// Translates a modifier's text ("+138 to maximum Life") into the identifier the
// trade API understands ("explicit.stat_3299347043").
//
// GGG publishes the templates at /api/trade/data/stats with `#` where the number
// goes. We normalise both sides and compare.

const STATS_URL = 'https://www.pathofexile.com/api/trade/data/stats';

/** Stat ids only change with patches, so the cache can be long. */
const TTL_MS = 24 * 60 * 60 * 1000;

/** Item field -> stat type in the trade API. */
export const MOD_FIELDS = [
  ['enchantMods', 'enchant'],
  ['implicitMods', 'implicit'],
  ['fracturedMods', 'fractured'],
  ['craftedMods', 'crafted'],
  ['explicitMods', 'explicit'],
];

function norm(text) {
  return String(text)
    .replace(/-?\d+(?:\.\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * The sign may live inside or outside the placeholder depending on the
 * template: the item says "-1 Prefix Modifier allowed" while GGG calls it
 * "+# Prefix Modifier allowed". So we index and look up without the sign too.
 */
function withoutSign(key) {
  return key.replace(/[+-]#/g, '#');
}

/** Defence templates carry a "(Local)" suffix; the item text doesn't. */
function withoutLocal(key) {
  return key.replace(/\s*\(local\)$/, '');
}

/**
 * Reduces a modifier to a comparable shape, so an item's roll can be matched
 * against poe.ninja's template:
 *   "(10-15)% increased Attack Speed while affected by Precision"  (template)
 *   "14% increased Attack Speed while affected by Precision"       (item)
 * both become "#% increased attack speed while affected by precision".
 */
export function modTemplate(text) {
  return String(text)
    .replace(/\(?-?\d+(?:\.\d+)?(?:\s*-\s*-?\d+(?:\.\d+)?)?\)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function valuesOf(text) {
  return (String(text).match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
}

async function fetchStats() {
  const cache = await chrome.storage.local.get('tradeStats');
  const entry = cache.tradeStats;
  if (entry && Date.now() - entry.at < TTL_MS) return entry.data;

  const res = await fetch(STATS_URL);
  if (!res.ok) throw new Error(`Trade stats returned ${res.status}`);
  const data = await res.json();
  await chrome.storage.local.set({ tradeStats: { at: Date.now(), data } });
  return data;
}

let index = null;

/** Map of `type -> normalised template -> stat id`, plus the pseudo group. */
export async function loadStatIndex() {
  if (index) return index;
  const data = await fetchStats();

  const byType = new Map();
  const pseudo = new Map();

  for (const group of data.result || []) {
    for (const e of group.entries || []) {
      const type = e.type || group.id;
      if (type === 'pseudo') pseudo.set(e.id, e);
      if (!byType.has(type)) byType.set(type, new Map());
      const map = byType.get(type);
      // Several keys for the same id: with and without "(Local)", with and
      // without the sign.
      for (const key of new Set([
        norm(e.text),
        withoutLocal(norm(e.text)),
        withoutSign(norm(e.text)),
        withoutSign(withoutLocal(norm(e.text))),
      ])) {
        if (!map.has(key)) map.set(key, e.id);
      }
    }
  }

  index = { byType, pseudo };
  return index;
}

/** Finds a modifier's stat id. Returns null when we don't recognise it. */
export function matchMod(statIndex, text, type) {
  const map = statIndex.byType.get(type);
  if (!map) return null;
  const key = norm(text);
  const id =
    map.get(key) ??
    map.get(withoutLocal(key)) ??
    map.get(withoutSign(key)) ??
    map.get(withoutSign(withoutLocal(key)));
  if (!id) return null;
  return { id, values: valuesOf(text) };
}

const RESIST_SINGLE = /^\+(-?\d+)% to (Fire|Cold|Lightning) Resistance$/;
const RESIST_DOUBLE = /^\+(-?\d+)% to (\w+) and (\w+) Resistances$/;
const RESIST_ALL = /^\+(-?\d+)% to all Elemental Resistances$/;

/**
 * The item's total elemental resistance, adding up the combined ones and the
 * "all" ones. This is the pseudo-mod people actually search gear with.
 */
export function totalElementalResistance(item) {
  let total = 0;
  for (const [field] of MOD_FIELDS) {
    for (const mod of item[field] || []) {
      let m = RESIST_SINGLE.exec(mod);
      if (m) { total += Number(m[1]); continue; }
      m = RESIST_ALL.exec(mod);
      if (m) { total += Number(m[1]) * 3; continue; }
      m = RESIST_DOUBLE.exec(mod);
      if (m && /fire|cold|lightning/i.test(m[2]) && /fire|cold|lightning/i.test(m[3])) {
        total += Number(m[1]) * 2;
      }
    }
  }
  return total;
}

const FLAT_LIFE = /^\+(-?\d+) to maximum Life$/;

export function totalLife(item) {
  let total = 0;
  for (const [field] of MOD_FIELDS) {
    for (const mod of item[field] || []) {
      const m = FLAT_LIFE.exec(mod);
      if (m) total += Number(m[1]);
    }
  }
  return total;
}

/**
 * Modifiers that actually move the price, in order. Everything else is ignored:
 * putting all six mods of a rare into the query returns zero results.
 */
const PRIORITY = [
  /chance to Suppress Spell Damage/i,
  /to Level of all .*Skill Gems/i,
  /increased Movement Speed/i,
  /to Global Critical Strike Multiplier/i,
  /increased Critical Strike Chance/i,
  /increased Attack Speed/i,
  /increased Cast Speed/i,
  /increased Spell Damage/i,
  /to maximum Energy Shield/i,
  /increased .*Evasion and Energy Shield/i,
  /increased Effect of Tailwind/i,
  /to Accuracy Rating/i,
];

/** Strips the type prefix: `fractured.stat_123` and `explicit.stat_123` match. */
const statNumber = (id) => id.replace(/^[a-z]+\./, '');

/**
 * Maps an item's own rolled modifiers, in the order they appear.
 *
 * For a rare this would be useless — six random mods find nothing. It exists
 * for uniques whose value depends entirely on the roll: a Watcher's Eye rolls
 * two or three mods out of ninety, and those mods *are* the item. Searching by
 * name alone returns the 40 c floor, which is what makes the `≥` mark useless.
 */
/** Default order: the mods a player reads first. */
const ROLLED_FIELDS = [['explicitMods', 'explicit'], ['implicitMods', 'implicit']];

/** Gear also carries fractured and crafted mods, and they matter for price. */
export const GEAR_FIELDS = [
  ['explicitMods', 'explicit'],
  ['fracturedMods', 'fractured'],
  ['craftedMods', 'crafted'],
];

export function rolledMods(statIndex, item, limit, rollPool, fields = ROLLED_FIELDS) {
  // Without the pool we'd take the first mods listed, and on a Watcher's Eye
  // those are the three every copy has (energy shield, life, mana). Filtering by
  // them finds every Watcher's Eye in the league — the floor price again. The
  // pool holds the modifiers poe.ninja marks `optional`, i.e. the rolled ones.
  const pool = rollPool?.length ? new Set(rollPool) : null;
  const out = [];
  for (const [field, type] of fields) {
    for (const mod of item[field] || []) {
      if (out.length >= limit) return out;
      if (pool && !pool.has(modTemplate(mod))) continue;
      const hit = matchMod(statIndex, mod, type);
      if (!hit || out.some((s) => s.id === hit.id)) continue;
      out.push({ ...hit, text: mod });
    }
  }
  return out;
}

/** Picks the item's significant mods, already translated to stat ids. */
export function significantMods(statIndex, item, limit) {
  const out = [];
  for (const pattern of PRIORITY) {
    if (out.length >= limit) break;
    for (const [field, type] of MOD_FIELDS) {
      if (out.length >= limit) break;
      for (const mod of item[field] || []) {
        if (!pattern.test(mod)) continue;
        const hit = matchMod(statIndex, mod, type);
        // Dedupe by stat number, not by full id: the same mod fractured and
        // explicit are two ids for one thing, and taking both burns a filter
        // slot without narrowing anything.
        if (!hit || out.some((s) => statNumber(s.id) === statNumber(hit.id))) continue;
        out.push({ ...hit, text: mod });
        break;
      }
    }
  }
  return out;
}
