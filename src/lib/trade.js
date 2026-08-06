// Searches against GGG's official trade site.
//
// The flow is the one poe.ninja itself uses: POST the query to the API, which
// returns an `id`, then open the regular trade page with that id.
//
// Limits measured from `X-Rate-Limit-Ip` (policy `trade-search-request-limit`):
//   5 per 10 s (60 s ban), 15 per 60 s (300 s ban),
//   30 per 300 s (1800 s ban), 600 per 21600 s (3600 s ban)

import { RateLimiter } from './rate-limit.js';
import { fetchCurrencyRates } from './economy.js';

const API = 'https://www.pathofexile.com/api/trade/search';
const FETCH = 'https://www.pathofexile.com/api/trade/fetch';
const WEB = 'https://www.pathofexile.com/trade/search';
const STATIC = 'https://www.pathofexile.com/api/trade/data/static';

// Search and fetch have separate policies and very different budgets
// (5 per 10 s versus 12 per 4 s), so each gets its own limiter.
export const searchLimit = new RateLimiter('search');
export const fetchLimit = new RateLimiter('fetch');

/**
 * Time with a request actually in flight to GGG, in milliseconds.
 *
 * The counterpart to the limiters' `waitedMs`: between them they account for a
 * pass. Only the search and fetch calls are counted — `/data/*` carries no rate
 * limit and is loaded once.
 */
export const network = { ms: 0 };

/** `fetch`, timed. */
async function timedFetch(url, init) {
  const started = Date.now();
  try {
    return await fetch(url, init);
  } finally {
    network.ms += Date.now() - started;
  }
}

/**
 * Turns an item into a trade query by name — good enough for uniques and gems,
 * which are identified by what they are rather than by what they rolled.
 *
 * Returns `null` for rares and magic items: those need stat filters, and are
 * handled by `buildComboQuery` and `buildRareQuery`.
 */
export function buildQuery(item) {
  const query = { status: status(), stats: [{ type: 'and', filters: [] }] };

  if (item.frameType === 4) {
    query.type = item.baseType;
    const misc = { corrupted: { option: String(!!item.corrupted) } };
    if (item.gemLevel) misc.gem_level = { min: item.gemLevel, max: item.gemLevel };
    if (item.gemQuality) misc.quality = { min: item.gemQuality };
    query.filters = { misc_filters: { filters: misc } };
    return { query, sort: { price: 'asc' } };
  }

  // unique (3) or foil (10)
  if ((item.frameType === 3 || item.frameType === 10) && item.name) {
    query.name = tradeName(item);
    query.type = item.baseType;
    const filters = {
      misc_filters: {
        filters: {
          corrupted: { option: String(!!item.corrupted) },
          mutated: { option: String(isMutated(item)) },
        },
      },
    };
    if (item.links >= 5) {
      filters.socket_filters = { filters: { links: { min: item.links } } };
    }
    query.filters = filters;
    return { query, sort: { price: 'asc' } };
  }

  return null;
}

/** How many of a unique's own mods to pin down when searching for its variant. */
const MAX_VARIANT_MODS = 3;

/**
 * Uniques where the number on the modifier is the whole point.
 *
 * For most uniques the roll range is narrow enough that requiring a minimum
 * only costs us listings. Timeless and Time-Lost jewels are the exception: the
 * number *is* the item. If you know of others, this is where they go.
 */
const VALUE_SENSITIVE =
  /^(time-lost|elegant hubris|militant faith|brutal restraint|glorious vanity|lethal pride|that which was taken)/i;

/**
 * How much of the item's own roll a listing must match, as a percentage.
 *
 * For a **unique** the modifier pool is fixed and the ranges are narrow, so
 * demanding a minimum mostly costs listings without changing the answer — which
 * is why they're searched at 0. Timeless and Time-Lost jewels are the exception:
 * there the number *is* the item.
 *
 * For a **rare** the magnitude is the entire value. A Cobalt Jewel with three
 * crit multi mods is worth 17 div at good rolls and a few chaos at bad ones;
 * searching without a minimum finds the bad ones and reports their price.
 * Awakened PoE Trade defaults to 80% here, and so do we.
 */
export const DEFAULT_MIN_ROLL = 80;

export function minRollFor(item, configured = DEFAULT_MIN_ROLL) {
  const isUnique = item.frameType === 3 || item.frameType === 10;
  if (!isUnique) return configured;
  return VALUE_SENSITIVE.test(item.name || '') ? configured : 0;
}

/**
 * Listing modes, straight out of the trade site's own dropdown.
 *
 * We used to hardcode `online` — "In Person (Online)" — which is the worst
 * choice for pricing: those sellers have to be messaged and may not answer, and
 * the asking prices are softer. `available` is the combined mode most people
 * price with; `securable` is instant buyout only.
 */
export const SALE_MODES = [
  { id: 'available', label: 'Instant Buyout and In Person' },
  { id: 'securable', label: 'Instant Buyout' },
  { id: 'online', label: 'In Person (Online)' },
  { id: 'onlineleague', label: 'In Person (Online in League)' },
  { id: 'any', label: 'Any' },
];

// Instant buyout only. An "In Person" listing is a message to a player who may
// never answer, so its asking price is softer and less of a real price.
export const DEFAULT_SALE_MODE = 'securable';

/**
 * Which listing mode the queries ask for.
 *
 * Module-level because every builder needs it and the service worker handles
 * one appraisal at a time; threading it through six signatures bought nothing.
 */
let saleMode = DEFAULT_SALE_MODE;

export function setSaleMode(mode) {
  saleMode = SALE_MODES.some((m) => m.id === mode) ? mode : DEFAULT_SALE_MODE;
}

function status() {
  return { option: saleMode };
}

/** Trade page URL carrying the query itself — costs no API request. */
export function searchUrl(league, body) {
  return `${WEB}/${encodeURIComponent(league)}?q=${encodeURIComponent(JSON.stringify(body))}`;
}

const PSEUDO_RESISTANCE = 'pseudo.pseudo_total_elemental_resistance';
const PSEUDO_CHAOS = 'pseudo.pseudo_total_chaos_resistance';

/** Trade files a timeless jewel's seed under one stat per historic figure. */
const TIMELESS_SEED = /^explicit\.pseudo_timeless_jewel_/;

/**
 * The name trade knows the item by.
 *
 * poe.ninja calls an Allflame mutation "Foulborn Tulfall"; trade calls it
 * "Tulfall" and answers 400 "Unknown item name" for anything else. The mutation
 * is a flag on the search, not part of the name. Verified against the API:
 * "Foulborn Tulfall" -> 400, "Tulfall" -> 3436, plus the flag -> 1851.
 */
export function tradeName(item) {
  return String(item.name || '').replace(/^Foulborn\s+/i, '');
}

/**
 * Whether trade should be asked for the Foulborn variant.
 *
 * The name is what decides, not the flag. poe.ninja carries `mutated` on some
 * items and not others — Tulfall had it, Lori's Lantern did not — but it always
 * renders the name, and "Foulborn Lori's Lantern" is not a name a plain unique
 * can have. Trusting the flag alone left the filter off entirely, and since a
 * Foulborn and a plain copy are different items at different prices, "off" is
 * the one answer that is always wrong.
 */
export function isMutated(item) {
  return !!item.mutated || /^Foulborn\s/i.test(String(item.name || ''));
}

/** Turns a set of totals into trade filters, skipping the ones at zero. */
function totalsToFilters(totals, keys, minRoll) {
  if (!totals) return null;
  const out = {};
  for (const key of keys) {
    const value = totals[key];
    if (!value) continue;
    // One decimal kept: weapon dps is fractional, defences are not.
    out[key] = minRoll > 0 ? { min: Math.floor((value * minRoll) / 10) / 10 } : {};
  }
  return Object.keys(out).length ? out : null;
}

/** Armour, evasion, energy shield, ward and block. */
function defenceFilters(item, minRoll) {
  return totalsToFilters(item.defences, ['ar', 'ev', 'es', 'ward', 'block'], minRoll);
}

/**
 * The weapon equivalent. A rare weapon is bought for its damage per second, not
 * for the modifiers that add up to it — the same argument as the defences.
 */
function weaponFilters(item, minRoll) {
  return totalsToFilters(item.weapon, ['dps', 'pdps', 'edps', 'aps', 'crit'], minRoll);
}


/** Query for one specific set of modifiers. */
export function buildComboQuery(item, mods, opts = {}) {
  const {
    byName = false, useCategory = false, minRoll = 0, resistance = 0, chaos = 0,
    // Leaves the corrupted filter off entirely, which is trade's "any". For
    // asking what an item is worth ignoring its corruption — see the caller.
    anyCorrupted = false,
  } = opts;
  const misc = {
    // Trade labels this flag "Foulborn". Set both ways, like corrupted: with it
    // true an Allflame mutation is priced as the ordinary unique, which it is
    // not; left unset on a plain item the search also matches Foulborn copies,
    // which are a different item at a different price.
    mutated: { option: String(isMutated(item)) },
  };
  if (!anyCorrupted) misc.corrupted = { option: String(!!item.corrupted) };

  // One pseudo filter instead of two or three individual resistances: it is how
  // people actually shop, and it frees the scarce filter slots for mods that
  // distinguish the item.
  const pseudo = [];
  // At min roll 0 these only ask that the item *has* resistance, the same as
  // every other filter at that setting. Demanding the full amount there made 0%
  // stricter than 80%, which is backwards.
  const pseudoTotal = (id, amount, floor) => {
    if (amount < floor) return;
    const filter = { id };
    if (minRoll > 0) filter.value = { min: Math.floor((amount * minRoll) / 100) };
    pseudo.push(filter);
  };
  pseudoTotal(PSEUDO_RESISTANCE, resistance, 30);
  // Lower bar than the elemental one: chaos resistance is scarce, so 15 points
  // on a ring is already a reason someone is buying it.
  pseudoTotal(PSEUDO_CHAOS, chaos, 15);
  const hasTotals =
    useCategory && (defenceFilters(item, minRoll) || weaponFilters(item, minRoll));
  if (!mods.length && !pseudo.length && !hasTotals) return null;

  const filters = pseudo.concat(mods.map((mod) => {
    const filter = { id: mod.id };
    const value = mod.values[0];
    // An id like `enchant.stat_3948993189|23` already names the exact variant —
    // the "|23" *is* the choice. Trade has nothing to compare a minimum against,
    // so asking for one on top returns nothing at all.
    const isOption = mod.id.includes('|');
    // An enchantment has no roll range — the wiki is explicit that its values
    // are fixed, which is why a Blessed Orb does nothing to one. So the roll
    // slider must not touch it: asking a "Adds 5 Passive Skills" cluster jewel
    // for 80% of five is asking for four, and a four-passive jewel is a
    // different, cheaper item. We were pricing five-passive jewels off them.
    if (typeof value === 'number' && !isOption && mod.id.startsWith('enchant.')) {
      filter.value = { min: value, max: value };
      return filter;
    }
    // A timeless jewel's number is its seed, and the seed is not a magnitude:
    // it is which passives the jewel rewrites. Seed 4240 and seed 5301 are two
    // unrelated jewels, so asking for "at least 80% of 5301" prices one off the
    // other. The seed is matched exactly or not at all.
    if (typeof value === 'number' && TIMELESS_SEED.test(mod.id)) {
      filter.value = { min: value, max: value };
      return filter;
    }
    if (minRoll > 0 && typeof value === 'number' && !isOption) {
      const floor = Math.floor((Math.abs(value) * minRoll) / 100);
      // A negative roll has to be bounded from above, not below. "33% reduced
      // Poison Duration on you" is -33 of the increased stat, and asking for
      // `min: -26` excludes every copy with more than 26% reduction —
      // including the item we are pricing, which would then fail to match its
      // own query. The invariant is that it always matches: whatever else a
      // search gets wrong, an item has to be in its own result set.
      filter.value = value < 0 ? { max: -floor } : { min: floor };
    }
    return filter;
  }));

  const query = {
    status: status(),
    stats: [{ type: 'and', filters }],
    filters: { misc_filters: { filters: misc } },
  };

  // Defences go in as the totals the item ends up with, the same numbers
  // poe.ninja shows and the trade site's own Armour Filters take. One filter
  // covers what "+93 to maximum Energy Shield" and "136% increased Energy
  // Shield" were spending two on, and it also matches items that reach the same
  // number a different way.
  // Only on the gear path. A unique is found by its name, and pinning its
  // defences on top would just exclude the copies with worse rolls.
  const defences = useCategory ? defenceFilters(item, minRoll) : null;
  if (defences) query.filters.armour_filters = { filters: defences };
  const weapon = useCategory ? weaponFilters(item, minRoll) : null;
  if (weapon) query.filters.weapon_filters = { filters: weapon };

  // Gear searches by category — "any boots with these mods". Pinning the exact
  // base on top of specific mods finds nothing: some bases have a single listing
  // in the whole league. Jewels and uniques keep the base, which is the point
  // for them.
  const category = useCategory ? categoryFor(item) : null;
  if (category) {
    query.filters.type_filters = { filters: { category: { option: category } } };
  } else {
    query.type = item.baseType;
  }
  if (byName && item.name) query.name = tradeName(item);

  // Links, for the uniques where they are the price. The Annihilating Light is
  // worth almost nothing under six links and a lot at six, and this path — the
  // one corrupted, Foulborn and variant uniques take — was not asking for them
  // at all, so it priced a 6L against the whole market including the 4Ls.
  // Only from five up: below that nobody sorts by links and demanding an exact
  // count would only cost listings.
  if (byName && item.links >= 5) {
    query.filters.socket_filters = { filters: { links: { min: item.links } } };
  }

  return { query, sort: { price: 'asc' } };
}

/** Every combination of `k` items, in order. */
export function* combinations(list, k) {
  if (k === 0) { yield []; return; }
  for (let i = 0; i <= list.length - k; i++) {
    for (const rest of combinations(list.slice(i + 1), k - 1)) {
      yield [list[i], ...rest];
    }
  }
}

/**
 * Wrapper kept for the gear path, which wants "the first N mods" rather than
 * the exhaustive search below.
 */
export function buildOwnModsQuery(item, statIndex, helpers, opts = {}) {
  const { rollPool, maxMods = MAX_VARIANT_MODS, fields, minRoll = DEFAULT_MIN_ROLL } = opts;
  const mods = helpers.rolledMods(statIndex, item, maxMods, rollPool, fields);
  return buildComboQuery(item, mods, {
    ...opts,
    minRoll,
    resistance: helpers.totalElementalResistance?.(item) ?? 0,
  });
}

const PSEUDO_LIFE = 'pseudo.pseudo_total_life';

/**
 * How many mod filters to add on top of the pseudo ones.
 *
 * Deliberately few. Each filter narrows enormously: with five, all seven rares
 * of the test build returned zero results.
 */
const MAX_MOD_FILTERS = 2;

/** Slack below the item's own rolls, so the search actually finds something. */
const SLACK = 0.9;

/**
 * Trade category from the equipment slot.
 *
 * Searching by exact base type is useless: there is ONE "Focused Amulet" listed
 * in the whole league, so any extra filter returns nothing. People search for
 * "any amulet with these mods", and that is the category.
 */
const CATEGORIES = {
  Helm: 'armour.helmet',
  BodyArmour: 'armour.chest',
  Boots: 'armour.boots',
  Gloves: 'armour.gloves',
  Offhand: 'armour.shield',
  Weapon: 'weapon',
  Weapon2: 'weapon',
  Ring: 'accessory.ring',
  Ring2: 'accessory.ring',
  Amulet: 'accessory.amulet',
  Belt: 'accessory.belt',
};

function categoryFor(item) {
  if (item.inventoryId === 'Offhand' && /quiver/i.test(item.baseType)) return 'armour.quiver';
  return CATEGORIES[item.inventoryId] || null;
}

/**
 * Query for a rare. It does not look for *this* item — that isn't for sale
 * anywhere — but for similar ones: same category and the mods that move the
 * price, asked for at 90% of the roll. The result means "one like this costs X",
 * not "this one is worth X".
 */
export function buildRareQuery(item, statIndex, helpers, maxMods = MAX_MOD_FILTERS) {
  const { significantMods, totalElementalResistance, totalLife } = helpers;
  const filters = [];

  const resistance = totalElementalResistance(item);
  if (resistance >= 30) {
    filters.push({ id: PSEUDO_RESISTANCE, value: { min: Math.floor(resistance * SLACK) } });
  }
  const life = totalLife(item);
  if (life >= 40) {
    filters.push({ id: PSEUDO_LIFE, value: { min: Math.floor(life * SLACK) } });
  }

  for (const mod of maxMods > 0 ? significantMods(statIndex, item, maxMods) : []) {
    const filter = { id: mod.id };
    const value = mod.values[0];
    if (typeof value === 'number') {
      filter.value = { min: Math.floor(Math.abs(value) * SLACK) * Math.sign(value || 1) };
    }
    filters.push(filter);
  }

  if (!filters.length) return null;

  const category = categoryFor(item);
  const query = {
    status: status(),
    stats: [{ type: 'and', filters }],
  };
  if (category) {
    query.filters = { type_filters: { filters: { category: { option: category } } } };
  } else {
    query.type = item.baseType; // no known category: at least pin the base
  }

  return { query, sort: { price: 'asc' } };
}

/**
 * Prices of the first listings of a search.
 * `/fetch` accepts up to 10 ids per request, so one call is enough.
 */
/**
 * Trade's currency ids in chaos: `alch` -> 1.2, `divine` -> 171.5.
 *
 * Two sources, because neither has both halves. Trade quotes a short id and
 * `/data/static` is the only place that says which orb it means; poe.ninja
 * publishes what each orb is worth but names it in full. Joining them on the
 * display name covers every currency a seller can pick, rather than the two we
 * happened to hard-code.
 *
 * `/data/*` carries no rate-limit headers, and both sides are cached, so this
 * costs nothing per item.
 */
let currencyChaos = null;
let currencyLeague = null;

async function loadCurrencyRates(league) {
  if (currencyChaos && currencyLeague === league) return currencyChaos;

  const [statics, rates] = await Promise.all([
    fetch(STATIC).then((r) => (r.ok ? r.json() : { result: [] })),
    fetchCurrencyRates(league),
  ]);

  const map = new Map();
  for (const group of statics.result || []) {
    for (const entry of group.entries || []) {
      const chaos = rates[entry.text];
      if (entry.id && chaos > 0) map.set(entry.id, chaos);
    }
  }
  currencyChaos = map;
  currencyLeague = league;
  return map;
}

/**
 * The chaos prices of the cheapest listings.
 *
 * `league` is optional: with it, every currency converts; without it we can only
 * read the two we know by name, which is what the standalone tools do.
 */
export async function fetchPrices(queryId, resultIds, chaosPerDivine, league = null) {
  const ids = resultIds.slice(0, 10);
  if (!ids.length) return [];

  let rates = null;
  if (league) {
    try {
      rates = await loadCurrencyRates(league);
    } catch {
      // Prices still work for chaos and divine; better than failing the item.
    }
  }

  await fetchLimit.take();

  const url = `${FETCH}/${ids.join(',')}?query=${encodeURIComponent(queryId)}`;
  const res = await timedFetch(url);
  fetchLimit.sync(res.headers);

  if (res.status === 429) {
    const retry = res.headers.get('Retry-After');
    fetchLimit.penalise(retry);
    throw new Error('GGG is rate limiting us.');
  }
  if (!res.ok) throw new Error(`Trade fetch returned ${res.status}`);

  const data = await res.json();
  const chaos = [];
  for (const line of data.result || []) {
    const price = line?.listing?.price;
    if (!price || typeof price.amount !== 'number') continue;
    const rate = rates?.get(price.currency)
      ?? (price.currency === 'chaos' ? 1
        : price.currency === 'divine' ? chaosPerDivine
        : null);
    if (rate > 0) chaos.push(price.amount * rate);
  }
  return chaos.sort((a, b) => a - b);
}

/**
 * Identical searches within a run, answered once.
 *
 * The appraisal cache is keyed on the item's own id, so two copies of the same
 * jewel in a build are two different items and each paid for its own search —
 * even though the query built from them is byte for byte the same. Awakened
 * caches on a hash of the request body for exactly this reason.
 *
 * In memory rather than storage: this exists to deduplicate within one pass,
 * and the appraisal cache already covers coming back to a build later.
 */
const QUERY_TTL_MS = 5 * 60 * 1000;
const queryCache = new Map();

/** Runs a search and returns its id and result ids, without opening anything. */
export async function runQuery(body, league) {
  const key = `${league}|${JSON.stringify(body)}`;
  const hit = queryCache.get(key);
  if (hit && Date.now() - hit.at < QUERY_TTL_MS) return hit.value;

  await searchLimit.take();

  const res = await timedFetch(`${API}/${encodeURIComponent(league)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // Sync first, even on an error: the headers are how we learn the real limits
  // and how much of them somebody else on this IP has already spent.
  searchLimit.sync(res.headers);

  if (res.status === 429) {
    const retry = res.headers.get('Retry-After');
    searchLimit.penalise(retry);
    throw new Error(`GGG is rate limiting us${retry ? `; retry in ${retry} s` : ''}.`);
  }
  if (!res.ok) throw new Error(`Trade returned ${res.status}`);
  const data = await res.json();
  const value = { id: data.id, result: data.result || [], total: data.total ?? 0 };
  queryCache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * How much to trust an appraisal, judged by the number of results.
 *
 * Many results means the filters narrowed nothing down: the median of the ten
 * cheapest among 250 helmets "with life and resistances" is 1 c of junk, not the
 * item's price. Too few is no good either — a single listing can be a made-up
 * price. Only `alta` and `media` should ever be summed into a total.
 */
export function reliability(total) {
  if (!total) return 'none';
  if (total > 120) return 'low';
  if (total < 3) return 'thin';
  if (total > 40) return 'medium';
  return 'high';
}

export const RELIABLE = new Set(['high', 'medium']);

/** Used to decide whether a second attempt actually improved things. */
const RANK = { high: 4, medium: 3, thin: 2, low: 1, none: 0 };

export function isBetter(newTotal, oldTotal) {
  return RANK[reliability(newTotal)] > RANK[reliability(oldTotal)];
}

/**
 * Which mod counts to try after the first attempt, in order.
 *
 * We step down or up one at a time depending on the problem: no results means
 * loosen, two hundred results means tighten. One step isn't always enough —
 * some items only show up with the pseudo-mods alone — but jumping straight to
 * the bottom overshoots, turning 0 results into 250 of junk.
 *
 * At most two extra attempts: each one is another search against GGG.
 */
export function attemptPlan(total, maxMods) {
  if (total === 0) return [maxMods - 1, maxMods - 2].filter((n) => n >= 0);
  if (total > 120) return [maxMods + 1, maxMods + 2];
  return [];
}

export function webUrl(league, queryId) {
  return `${WEB}/${encodeURIComponent(league)}/${queryId}`;
}
