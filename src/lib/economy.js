import { modTemplate } from './stats.js';

// Access to poe.ninja's *documented* economy API.
// Docs: https://poe.ninja/docs/api
//
// Rules the docs ask for, honoured here:
//  - PoE1 data refreshes roughly every 15 min and responses are cached ~5 min,
//    so asking more often is pointless: we cache in chrome.storage.
//  - Descriptive User-Agent (set by background.js via declarativeNetRequest).
//  - Reasonable volume and concurrency (see CONCURRENCY).

const BASE = 'https://poe.ninja/poe1/api/economy';

/** Local cache TTL. The docs say the data refreshes about every 15 min. */
const TTL_MS = 10 * 60 * 1000;

/** Maximum simultaneous requests against poe.ninja. */
const CONCURRENCY = 3;

/**
 * What a character buys that is not gear: tattoos and runegrafts.
 *
 * They live on the passive tree, so they never appear among the items and had
 * no way into the total at all. Not a rounding error either — the character
 * this was measured on carried 28 tattoos and 2 runegrafts, and one runegraft
 * alone was 1463 chaos.
 *
 * They are published under the **exchange** endpoint rather than the item one,
 * which is why they were missed: `type=Tattoo` on the item overview is a 404.
 * And they cost nothing to add — poe.ninja publishes a price for each, so not
 * one trade search goes out for them.
 */
export const EXCHANGE_TYPES = ['Tattoo', 'Runegraft'];

/**
 * Categories of `stash/current/item/overview` that can show up as gear on a
 * build. Order barely matters; they're fetched with limited parallelism.
 */
export const GEAR_TYPES = [
  'UniqueWeapon',
  'UniqueArmour',
  'UniqueAccessory',
  'UniqueFlask',
  'UniqueJewel',
  'ForbiddenJewel',
  'UniqueRelic',
  'UniqueTincture',
  'ShrineBelt',
  'Wombgift',
  'ClusterJewel',
  'SkillGem',
  'ImbuedGem',
];

/**
 * Items whose published price is a FLOOR, not a price: the value depends on a
 * roll the economy API doesn't split into separate lines.
 *
 * Most are detected automatically by counting `optional` modifiers (see
 * `isFloorPriced`): a normal unique has 0, a Watcher's Eye has 87. But some vary
 * by something that isn't a mod — the keystone on an Impossible Escape, the node
 * on a timeless jewel — and those have to be listed by hand.
 */
const FLOOR_PRICED = new Set([
  'impossible escape',
  'split personality',
  'forbidden flame',
  'forbidden flesh',
  'elegant hubris',
  'militant faith',
  'brutal restraint',
  'glorious vanity',
  'lethal pride',
  'that which was taken',
]);

/** How many `optional` mods before we treat the price as a floor. */
const OPTIONAL_MODS_THRESHOLD = 4;

/** Frame classes poe.ninja uses for uniques and their foil variants. */
function isUniqueLine(line) {
  return line.itemClass === 3 || line.itemClass === 10;
}

function isFloorPriced(line) {
  if (FLOOR_PRICED.has(normalizeName(line.name))) return true;
  const optional = (line.explicitModifiers || []).filter((m) => m.optional).length;
  return optional > OPTIONAL_MODS_THRESHOLD;
}

/** Normalises an item name so DOM text and API names can be compared. */
export function normalizeName(raw) {
  return String(raw)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // combining diacritics
    .replace(/[’'`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * A Foulborn's mutations, as one comparable string.
 *
 * Sorted, because an item carrying two of them says nothing about the order
 * poe.ninja listed them in. Empty for an ordinary unique, which is what makes
 * the same comparison work for both.
 */
export function mutationKey(mods) {
  return (mods || [])
    .map((m) => modTemplate(m.text || m))
    .sort()
    .join('|');
}

/** A published modifier, comparable, but with its numbers left in. */
export function fixedModKey(text) {
  return String(text).replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The published modifiers that name a variant rather than vary within it.
 *
 * poe.ninja splits some uniques into lines that differ by nothing but a
 * modifier — Mageblood by how many flasks it applies, Ralakesh's Impatience by
 * which charge it maxes — and the spread is not cosmetic: 221 divine for a
 * four-flask Mageblood against 1426 for a five.
 *
 * `modTemplate` cannot tell those apart, because the first thing it does is
 * replace every number with `#`, which turns "Leftmost 4 Magic Utility Flasks"
 * and "Leftmost 3" into the same string. So this keeps the text as written and
 * instead drops the modifiers carrying a published *range* — `+(30-60) to
 * Dexterity` is a roll every copy has in some amount, and no copy will match it
 * literally. What is left is fixed for the line: it either appears on the item
 * word for word or the item is a different variant.
 */
export function variantMods(mods) {
  const texts = (mods || []).map((m) => m.text || m);
  return {
    // *Which* modifiers the line has, numbers ignored. Atziri's Splendour has
    // nine lines that differ by which defences roll — armour, evasion, energy
    // shield, life — and every one of those is a range no copy matches word for
    // word. Templates separate them; literals cannot.
    tpl: texts.map(modTemplate),
    // ...and the ones whose number *is* the variant, kept as written. These
    // separate what templates cannot: "leftmost # magic utility flasks" is one
    // template for four different Mageblood prices.
    fixed: texts
      .filter((text) => !/\(\s*-?\d+(?:\.\d+)?\s*-\s*-?\d+(?:\.\d+)?\s*\)/.test(text))
      .map(fixedModKey),
  };
}

async function cacheGet(key) {
  const store = await chrome.storage.local.get(key);
  const entry = store[key];
  if (!entry) return null;
  if (Date.now() - entry.at > TTL_MS) return null;
  return entry.data;
}

async function cacheSet(key, data) {
  await chrome.storage.local.set({ [key]: { at: Date.now(), data } });
}

async function getJson(url, cacheKey) {
  if (cacheKey) {
    const hit = await cacheGet(cacheKey);
    if (hit) return hit;
  }
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`poe.ninja ${res.status} at ${url}`);
  const data = await res.json();
  if (cacheKey) await cacheSet(cacheKey, data);
  return data;
}

/** Economy leagues. The first one is the current temporary league. */
export async function fetchLeagues() {
  return getJson(`${BASE}/leagues`, 'leagues');
}

/**
 * What every currency is worth in chaos, by its full name.
 *
 * Trade quotes prices in whatever the seller picked, and on cheap gear that is
 * almost never chaos: the ten cheapest rare belts in a league are all "1 alch".
 * Without this the price comes back empty for items with thousands of listings.
 *
 * Same documented economy endpoint as the item overviews, so it costs one more
 * request per league and shares the same 10-minute cache.
 */
export async function fetchCurrencyRates(league) {
  const url = `${BASE}/stash/current/currency/overview?league=${encodeURIComponent(league)}&type=Currency`;
  const data = await getJson(url, `cur:${league}`);
  const rates = {};
  for (const line of data.lines || []) {
    if (line.currencyTypeName && line.chaosEquivalent > 0) {
      rates[line.currencyTypeName] = line.chaosEquivalent;
    }
  }
  // The endpoint prices everything *against* chaos, so chaos itself is absent.
  rates['Chaos Orb'] = 1;
  return rates;
}

/**
 * The same thing from poe.ninja's bulk exchange, keyed by **trade's own
 * currency id** rather than by display name.
 *
 * Used only to fill gaps. The stash overview above covers 66 currencies and
 * trade lets a seller price in 103, and the difference is not filtered out —
 * `fetchPrices` drops a listing it cannot convert without saying so. Mirror of
 * Kalandra is one of the missing ones, which is how a four-mirror listing came
 * to be visible on the trade site and absent from our prices.
 *
 * **Never used to override a rate the stash overview has.** The two are
 * different markets and they disagree: of the 64 currencies both carry, 18
 * agree within a quarter, the stash appears to floor cheap currency at 1 chaos,
 * and the Divine Orb differs by 15%. Preferring this one wholesale would move
 * every price the extension shows, and the item index those prices are added to
 * is denominated with the other. So it fills holes and touches nothing else.
 *
 * `primaryValue` is in chaos. Checked against poe.ninja's own page: a mirror at
 * 115685 chaos over a divine at 216.5 is 534 divine, which is the number the
 * site prints.
 */
export async function fetchExchangeRates(league) {
  const url = `${BASE}/exchange/current/overview?league=${encodeURIComponent(league)}&type=Currency`;
  const data = await getJson(url, `exch:${league}`);
  const rates = {};
  for (const line of data.lines || []) {
    if (line.id && line.primaryValue > 0) rates[line.id] = line.primaryValue;
  }
  return rates;
}

/** Overview of one item category for a league. */
async function fetchOverview(league, type) {
  const url = `${BASE}/stash/current/item/overview?league=${encodeURIComponent(league)}&type=${encodeURIComponent(type)}`;
  const data = await getJson(url, `ov:${league}:${type}`);
  return data.lines || [];
}

/** Runs `tasks` with a concurrency limit, without aborting if one fails. */
async function pooled(tasks, limit) {
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const i = cursor++;
      try {
        results[i] = { ok: true, value: await tasks[i]() };
      } catch (err) {
        results[i] = { ok: false, error: err };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Of all the lines sharing a name, picks the "representative" one.
 *
 * poe.ninja publishes one line per variant / links / corruption combination and
 * we can't tell from the DOM which one the character has. We take the highest
 * `listingCount`: the one that sells most, i.e. the ordinary version.
 */
function pickRepresentative(lines) {
  return lines.reduce((best, line) =>
    (line.listingCount ?? 0) > (best.listingCount ?? 0) ? line : best,
  );
}

/**
 * Builds the index sent to the content script: a plain object of
 * `normalised name -> price summary`. It stays at a few thousand entries, far
 * lighter than shipping the full lines.
 */
/**
 * One exchange category, as `[display name, chaos]` pairs.
 *
 * The two halves of the response are useless apart: `lines` prices an opaque
 * id (`runegraft-of-the-fortress`) and `items` is what turns that id back into
 * the name the character page writes.
 */
async function fetchExchange(league, type) {
  const url = `${BASE}/exchange/current/overview`
    + `?league=${encodeURIComponent(league)}&type=${encodeURIComponent(type)}`;
  const data = await getJson(url, `ex:${league}:${type}`);
  const nameById = new Map((data.items || []).map((entry) => [entry.id, entry.name]));

  const priced = [];
  for (const line of data.lines || []) {
    const name = nameById.get(line.id);
    if (name && line.primaryValue > 0) priced.push([name, line.primaryValue]);
  }
  return priced;
}

export async function buildPriceIndex(league) {
  const settled = await pooled(
    GEAR_TYPES.map((type) => () => fetchOverview(league, type).then((lines) => ({ type, lines }))),
    CONCURRENCY,
  );
  const exchanged = await pooled(
    EXCHANGE_TYPES.map((type) => () => fetchExchange(league, type).then((priced) => ({ type, priced }))),
    CONCURRENCY,
  );

  const failed = [];
  const byName = new Map();
  const gemNames = new Set();
  const forbidden = new Map();

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (!result.ok) {
      failed.push({ type: GEAR_TYPES[i], error: String(result.error.message || result.error) });
      continue;
    }
    const { type, lines } = result.value;
    for (const line of lines) {
      if (!line.name) continue;

      // Forbidden jewels are published under the name of the *passive* they
      // grant ("Ngamahu, Flame's Advance"), while the character page shows
      // "Forbidden Flame Crimson Jewel". We collect them by variant and do NOT
      // index them by name: otherwise the character's ascendancy list
      // ("Deathmarked", "Mistwalker") would be priced as if it were a jewel.
      if (type === 'ForbiddenJewel') {
        if (line.variant) {
          const prev = forbidden.get(line.variant);
          if (!prev || (line.chaosValue ?? Infinity) < prev) {
            forbidden.set(line.variant, line.chaosValue ?? Infinity);
          }
        }
        continue;
      }

      const key = normalizeName(line.name);
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(line);
      if (type === 'SkillGem' || type === 'ImbuedGem') gemNames.add(key);
    }
  }

  const index = {};
  const icons = {};

  for (const [key, lines] of byName) {
    const pick = pickRepresentative(lines);
    const variants = new Set(lines.map((l) => l.variant).filter(Boolean));
    const entry = {
      name: pick.name,
      baseType: pick.baseType || null,
      chaos: pick.chaosValue ?? null,
      divine: pick.divineValue ?? null,
      listings: pick.listingCount ?? 0,
      variantCount: variants.size,
      spread: priceSpread(lines),
      floor: lines.some(isFloorPriced),
    };

    // For floor-priced items we keep the pool of modifiers that actually roll,
    // so a trade search can pin down *this* copy instead of matching every one.
    // Only ~50 entries carry it, so the index stays small.
    if (entry.floor) {
      const pool = new Set();
      for (const line of lines) {
        for (const mod of line.explicitModifiers || []) {
          if (mod.optional && mod.text) pool.add(modTemplate(mod.text));
        }
      }
      if (pool.size) entry.rollPool = [...pool];
    }

    // A unique's published implicits are the ones every copy has. Anything else
    // on the item came from a corruption, and that is what separates a 5 c
    // Le Heup of All from a very expensive one.
    if (isUniqueLine(pick)) {
      const implicits = new Set();
      for (const line of lines) {
        for (const mod of line.implicitModifiers || []) {
          if (mod.text) implicits.add(modTemplate(mod.text));
        }
      }
      if (implicits.size) entry.implicitPool = [...implicits];

      // Every explicit the plain unique is published with.
      //
      // A Foulborn has one or more of its modifiers *replaced* by mutated ones,
      // so the same subtraction that finds a corruption implicit finds the
      // mutation: whatever the item carries that the plain unique does not is
      // what the Allflame put there. That matters when poe.ninja's page data
      // does not expose `mutatedMods` — it did for Tulfall and did not for
      // Lori's Lantern — because then the mutation is the whole difference from
      // the ordinary unique and nothing else identifies it.
      const explicits = new Set();
      for (const line of lines) {
        // Mutated lines would poison the reference with the very modifiers we
        // are trying to detect.
        if (line.mutatedModifiers?.length) continue;
        for (const mod of line.explicitModifiers || []) {
          if (mod.text) explicits.add(modTemplate(mod.text));
        }
      }
      if (explicits.size) entry.modPool = [...explicits];
    }

    // For gems we keep every level/quality roll: the character page shows
    // "Empower Support 4 / 20", so we can hit the exact line instead of settling
    // for the best-selling one.
    if (gemNames.has(key)) {
      entry.gems = lines
        .filter((l) => typeof l.chaosValue === 'number')
        .map((l) => [l.gemLevel ?? 0, l.gemQuality ?? 0, l.corrupted ? 1 : 0, l.chaosValue]);
    } else if (lines.length > 1 || isUniqueLine(pick)) {
      // Uniques: poe.ninja publishes a line per link count, corruption *and*
      // Foulborn mutation. With the real item JSON we know all three.
      //
      // The mutation used to be dropped, which collapsed every mutation sharing
      // a link count into whichever line came first. Null's Inclination has
      // twelve lines and the spread is not small: the same "Summon Phantasm"
      // mutation is 585 c at six links, 7.8 c at five and 5.8 c unlinked.
      entry.uniq = lines
        .filter((l) => typeof l.chaosValue === 'number')
        .map((l) => [
          l.links ?? 0,
          l.corrupted ? 1 : 0,
          l.chaosValue,
          mutationKey(l.mutatedModifiers),
          l.listingCount ?? 0,
          // What tells two lines apart when links, corruption and mutation are
          // all the same — which for a belt is always. Without it the four
          // Mageblood lines collapse into whichever poe.ninja sent first, and it
          // sends them dearest first.
          variantMods(l.explicitModifiers),
        ]);
    }

    index[key] = entry;

    // The page writes "Watcher's Eye Prismatic Jewel": name + baseType.
    if (pick.baseType) {
      const withBase = normalizeName(`${pick.name} ${pick.baseType}`);
      if (!index[withBase]) index[withBase] = entry;
    }

    // Equipment is drawn with icons only, no text. The economy API returns the
    // same poecdn URL, so we index by the art filename.
    //
    // Jewels and gems are deliberately excluded: the page always spells them out
    // in words, and their art is the *base* art. A rare Large Cluster Jewel and
    // the unique "The Light of Meaning" share `AfflictionJewel.png`, so matching
    // by icon there only invents prices.
    const isJewelOrGem = entry.gems || /\bjewel\b/i.test(entry.baseType || '');
    const art = isJewelOrGem ? null : artFilename(pick.icon);
    if (art) {
      // Only if unambiguous: if two uniques share art, we don't guess.
      if (art in icons && icons[art] !== key) icons[art] = null;
      else icons[art] = key;
    }
  }

  for (const [variant, chaos] of forbidden) {
    const key = normalizeName(variant);
    if (index[key]) continue;
    index[key] = {
      name: variant,
      baseType: null,
      chaos: Number.isFinite(chaos) ? chaos : null,
      divine: null,
      listings: 0,
      variantCount: 0,
      spread: null,
      floor: true, // the real price depends on which passive it grants
    };
  }

  // Last, so a real item always wins the name: gear is what the panel can put a
  // badge on, and nothing here should ever shadow it.
  for (let i = 0; i < exchanged.length; i++) {
    const result = exchanged[i];
    if (!result.ok) {
      failed.push({ type: EXCHANGE_TYPES[i], error: String(result.error.message || result.error) });
      continue;
    }
    for (const [name, chaos] of result.value.priced) {
      const key = normalizeName(name);
      if (index[key]) continue;
      index[key] = {
        name,
        baseType: null,
        chaos,
        divine: null,
        listings: 0,
        variantCount: 0,
        spread: null,
      };
    }
  }

  for (const art of Object.keys(icons)) {
    if (icons[art] === null) delete icons[art];
  }

  return { index, icons, failed, chaosPerDivine: estimateChaosPerDivine(byName) };
}

/** `.../b84147fcbd/AssassinationUnique2.png` -> `AssassinationUnique2.png` */
export function artFilename(iconUrl) {
  if (!iconUrl) return null;
  const file = String(iconUrl).split('?')[0].split('/').pop();
  return file && file.endsWith('.png') ? file : null;
}

/** Chaos range [min, max] across every variant sharing a name. */
function priceSpread(lines) {
  const values = lines.map((l) => l.chaosValue).filter((v) => typeof v === 'number' && v > 0);
  if (values.length < 2) return null;
  return [Math.min(...values), Math.max(...values)];
}

/**
 * Divine price in chaos, derived from the lines themselves (each carries both
 * chaosValue and divineValue). Median of the ratios so no outlier skews it.
 */
function estimateChaosPerDivine(byName) {
  const ratios = [];
  for (const lines of byName.values()) {
    for (const l of lines) {
      if (l.chaosValue > 0 && l.divineValue > 0) ratios.push(l.chaosValue / l.divineValue);
    }
  }
  if (!ratios.length) return null;
  ratios.sort((a, b) => a - b);
  return ratios[Math.floor(ratios.length / 2)];
}
