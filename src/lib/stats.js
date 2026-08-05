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
  const localByType = new Map();
  const pseudo = new Map();

  for (const group of data.result || []) {
    for (const e of group.entries || []) {
      const type = e.type || group.id;
      if (type === 'pseudo') pseudo.set(e.id, e);

      // Local and global variants share the item's wording exactly: a body
      // armour and a ring both read "+93 to maximum Energy Shield", and only the
      // template's "(Local)" suffix tells them apart. Merging them meant always
      // picking the global one, so a chest was searched for a modifier that only
      // exists on jewellery. They get separate maps, and the caller says which
      // it wants based on the slot.
      const local = /\(local\)$/i.test(e.text.trim());
      const target = local ? localByType : byType;
      if (!target.has(type)) target.set(type, new Map());
      const map = target.get(type);

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

  const allIds = new Set();
  for (const map of byType.values()) for (const id of map.values()) allIds.add(id);
  for (const map of localByType.values()) for (const id of map.values()) allIds.add(id);

  index = { byType, localByType, pseudo, allIds };
  return index;
}

/**
 * Rewrites a fractured or crafted stat id to its plain explicit twin.
 *
 * `fractured.stat_3556824919` doesn't mean "has +12% global crit multi" — it
 * means "has it *and it is fractured*". In the current league that's 7 listings
 * against 2712 for the explicit id. Same trap for crafted. We care that the item
 * has the modifier, not how it got there.
 */
const REWRITABLE = /^(fractured|crafted)\./;

export function preferExplicit(statIndex, id) {
  // A whitelist, not a blacklist. Fractured and crafted describe *how* a
  // modifier got onto the item, so the explicit twin is the same modifier asked
  // for more broadly. Every other prefix is a different place on the item, and
  // rewriting it asks for something no listing has. Both cost real money here:
  //
  //   enchant  a cluster jewel's "Adds 5 Passive Skills" matches the market as
  //            `enchant.stat_3086156145` and nothing at all as `explicit.` —
  //            which is why cluster jewels never priced.
  //   implicit a corrupted Le Heup's "Bleeding cannot be inflicted on you" is
  //            an implicit. No Le Heup carries it as an explicit, so the query
  //            found nothing, fell back to a pair of common mods and returned
  //            the 1 c floor of the commonest ring in the game.
  if (!REWRITABLE.test(id)) return id;
  const twin = `explicit.${id.replace(/^[a-z]+\./, '')}`;
  return statIndex.allIds?.has(twin) ? twin : id;
}

/**
 * Slots whose base carries its own defences, so a defence modifier on them is
 * the local one. On a ring or a jewel the identical wording means the global
 * stat instead.
 */
const LOCAL_SLOTS = new Set([
  'Helm', 'BodyArmour', 'Boots', 'Gloves', 'Offhand', 'Weapon', 'Weapon2',
]);

export function wantsLocalStats(item) {
  return LOCAL_SLOTS.has(item?.inventoryId);
}

function lookup(map, key) {
  if (!map) return null;
  return (
    map.get(key) ??
    map.get(withoutLocal(key)) ??
    map.get(withoutSign(key)) ??
    map.get(withoutSign(withoutLocal(key))) ??
    null
  );
}

/** Finds a modifier's stat id. Returns null when we don't recognise it. */
export function matchMod(statIndex, text, type, local = false) {
  const key = norm(text);
  // On gear the local variant wins when there is one; everywhere else, and for
  // modifiers with no local form, we fall through to the ordinary map.
  const id =
    (local ? lookup(statIndex.localByType?.get(type), key) : null) ??
    lookup(statIndex.byType.get(type), key) ??
    // Filed somewhere else than the item says. A cluster jewel reports "Adds 5
    // Passive Skills" and its notables as enchantments, because that is how the
    // game applies them, but trade only lists them as explicit — so looking in
    // the enchant bucket finds nothing and the modifier that defines the jewel
    // gets dropped. Knowing the text is what matters; where it was filed isn't.
    (type !== 'explicit' ? lookup(statIndex.byType.get('explicit'), key) : null);
  if (!id) return null;
  return { id: preferExplicit(statIndex, id), values: valuesOf(text) };
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
/**
 * Every field that holds a real modifier.
 *
 * Fractured used to be missing here, and it cost us: a rare jewel in the test
 * build carried "+12% to Global Critical Strike Multiplier" as a fractured mod,
 * so we searched three of its four modifiers and left out the dearest one.
 */
const ROLLED_FIELDS = [
  ['explicitMods', 'explicit'],
  ['fracturedMods', 'fractured'],
  ['craftedMods', 'crafted'],
  ['implicitMods', 'implicit'],
  // Last, so it never displaces an explicit modifier on ordinary gear, where an
  // enchantment is a nice extra rather than the point. On a cluster jewel it is
  // the point: "Adds 5 Passive Skills" lives here and moves the price, and the
  // cluster ordering below pulls it up when it matters.
  ['enchantMods', 'enchant'],
];

/** Gear also carries fractured and crafted mods, and they matter for price. */
export const GEAR_FIELDS = [
  ['explicitMods', 'explicit'],
  ['fracturedMods', 'fractured'],
  ['craftedMods', 'crafted'],
];

/**
 * Elemental resistances are searched as one pseudo total, never individually.
 *
 * Nobody shops for "+46% fire and +43% lightning" — they shop for enough
 * resistance, from wherever. Filtering each one separately also burns two or
 * three of the handful of filters we can afford on something a pseudo expresses
 * in one.
 */
const IS_RESISTANCE = /^\+-?\d+% to (\w+ )?(and \w+ )?Resistances?$/i;

export function isResistanceMod(text) {
  return IS_RESISTANCE.test(text.trim()) && /fire|cold|lightning|elemental/i.test(text);
}

/**
 * Modifiers whose effect is already expressed by a property filter.
 *
 * A weapon is bought for its damage per second and a chest for its energy
 * shield; the modifiers that add up to those numbers say the same thing twice
 * and would eat the few filter slots we have. This only applies on gear, where
 * these modifiers are local — on a jewel the same wording is global and real.
 */
const COVERED_BY_TOTALS = [
  /^[+-]?\d+ to (maximum Energy Shield|Armour|Evasion Rating|Ward)$/i,
  /^\d+% increased (Armour|Evasion|Energy Shield|Ward)$/i,
  /^\d+% increased (Armour and Evasion|Armour and Energy Shield|Evasion and Energy Shield|Armour, Evasion and Energy Shield)$/i,
  /^\d+% increased Physical Damage$/i,
  /^Adds \d+ to \d+ (Physical|Fire|Cold|Lightning|Chaos) Damage$/i,
  /^\d+% increased Attack Speed$/i,
  /^\d+% increased Critical Strike Chance$/i,
  /^[+-]?\d+% Chance to Block$/i,
];

export function isCoveredByTotals(text) {
  const t = text.trim();
  return COVERED_BY_TOTALS.some((re) => re.test(t));
}

/**
 * A cluster jewel is bought for the notables it adds, and for how many passives
 * it has. Everything else on it — the small-passive grants, the resistances —
 * is filler that every cluster jewel of that base carries.
 *
 * Without this the first three modifiers listed win, and on a real jewel those
 * were two resistance grants and one of its two notables, so the notable that
 * made it worth buying never reached the query.
 */
const CLUSTER_PRIORITY = [
  /^\d+ Added Passive Skill is /i,
  /^Adds \d+ Passive Skills?$/i,
  /^Added Small Passive Skills grant: /i,
];

export function isClusterJewel(item) {
  return /cluster jewel/i.test(item?.baseType || '');
}

/** Reorders a cluster jewel's modifiers so the notables come first. */
function clusterFirst(entries) {
  const rank = (text) => {
    const i = CLUSTER_PRIORITY.findIndex((re) => re.test(text));
    return i === -1 ? CLUSTER_PRIORITY.length : i;
  };
  return entries.slice().sort((a, b) => rank(a.mod) - rank(b.mod));
}

/**
 * The implicits a unique did not come with, i.e. what a corruption added.
 *
 * poe.ninja publishes the implicits every copy of a unique has, so anything on
 * the item beyond that pool is a corruption. This is what separates a cheap
 * Le Heup of All from one with "+1 to Maximum Power Charges", and pricing the
 * two the same is the sort of error that makes a whole build's total wrong.
 *
 * The Foulborn mutation is handled separately: it is a flag on the search, not
 * a modifier to match.
 */
export function corruptedImplicits(statIndex, item, implicitPool) {
  if (!item.corrupted) return [];
  // An empty pool is not a reason to give up — it is the clearest case there is.
  // Le Heup of All is built on an Iron Ring, which has no implicit at all, so
  // poe.ninja publishes none and the "Bleeding cannot be inflicted on you" on
  // this copy can only have come from the corruption. Bailing out here priced it
  // as the plain unique: 10000 listings, 1 c, which is the floor for the
  // commonest ring in the game and nothing to do with this one.
  //
  // Guessing wrong costs little — a filter every copy carries narrows nothing —
  // while ignoring a corruption implicit misprices the item outright.
  const known = new Set(implicitPool || []);
  const out = [];
  for (const mod of item.implicitMods || []) {
    if (known.has(modTemplate(mod))) continue;
    const hit = matchMod(statIndex, mod, 'implicit');
    if (hit) out.push({ ...hit, text: mod });
  }
  return out;
}

/**
 * The modifiers an Allflame mutation changed.
 *
 * They live in their own field on the item but are ordinary explicit stats as
 * far as trade is concerned. On a Foulborn they are the whole difference from
 * the plain unique, so they lead the query the same way a corruption implicit
 * does.
 */
export function mutatedMods(statIndex, item) {
  const out = [];
  for (const mod of item.mutatedMods || []) {
    const hit = matchMod(statIndex, mod, 'explicit');
    if (hit) out.push({ ...hit, text: mod });
  }
  return out;
}

export function rolledMods(statIndex, item, limit, rollPool, fields = ROLLED_FIELDS) {
  // Without the pool we'd take the first mods listed, and on a Watcher's Eye
  // those are the three every copy has (energy shield, life, mana). Filtering by
  // them finds every Watcher's Eye in the league — the floor price again. The
  // pool holds the modifiers poe.ninja marks `optional`, i.e. the rolled ones.
  const pool = rollPool?.length ? new Set(rollPool) : null;
  const local = wantsLocalStats(item);

  const candidates = [];
  for (const [field, type] of fields) {
    for (const mod of item[field] || []) {
      if (pool && !pool.has(modTemplate(mod))) continue;
      // Resistances and defences are covered by the pseudo total and the
      // property filters the caller adds, so they never take a filter slot here.
      if (isResistanceMod(mod)) continue;
      if (local && isCoveredByTotals(mod)) continue;
      candidates.push({ mod, type });
    }
  }

  const ordered = isClusterJewel(item) ? clusterFirst(candidates) : candidates;

  const out = [];
  for (const { mod, type } of ordered) {
    if (out.length >= limit) break;
    const hit = matchMod(statIndex, mod, type, local);
    if (!hit || out.some((s) => s.id === hit.id)) continue;
    out.push({ ...hit, text: mod });
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
