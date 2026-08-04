// Searches against GGG's official trade site.
//
// The flow is the one poe.ninja itself uses: POST the query to the API, which
// returns an `id`, then open the regular trade page with that id.
//
// Limits measured from `X-Rate-Limit-Ip` (policy `trade-search-request-limit`):
//   5 per 10 s (60 s ban), 15 per 60 s (300 s ban),
//   30 per 300 s (1800 s ban), 600 per 21600 s (3600 s ban)

import { RateLimiter } from './rate-limit.js';

const API = 'https://www.pathofexile.com/api/trade/search';
const FETCH = 'https://www.pathofexile.com/api/trade/fetch';
const WEB = 'https://www.pathofexile.com/trade/search';

// Search and fetch have separate policies and very different budgets
// (5 per 10 s versus 12 per 4 s), so each gets its own limiter.
export const searchLimit = new RateLimiter('search');
export const fetchLimit = new RateLimiter('fetch');

/**
 * Turns an item into a trade query.
 * Returns `null` for anything we can't search yet (rares and magic items need
 * stat filters and pseudo-mods — see `buildRareQuery`).
 *
 * NOT WIRED TO ANYTHING right now: the "open in trade" button was removed from
 * the UI because it misbehaved. Kept alongside `search()` because both are
 * tested and bringing the button back is just calling them again.
 */
export function buildQuery(item) {
  const query = { status: { option: 'online' }, stats: [{ type: 'and', filters: [] }] };

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
    query.name = item.name;
    query.type = item.baseType;
    const filters = {
      misc_filters: { filters: { corrupted: { option: String(!!item.corrupted) } } },
    };
    if (item.links >= 5) {
      filters.socket_filters = { filters: { links: { min: item.links } } };
    }
    query.filters = filters;
    return { query, sort: { price: 'asc' } };
  }

  return null;
}

export function canSearch(item) {
  return buildQuery(item) !== null;
}

/** How many of a unique's own mods to pin down when searching for its variant. */
const MAX_VARIANT_MODS = 3;

/**
 * Query for a unique whose price depends on which mods it rolled.
 *
 * poe.ninja publishes a single price for all Watcher's Eyes — the cheapest one —
 * so the economy number is a floor, not a value. Here we search for the actual
 * item: same name and base, plus the mods it actually rolled. That's the only
 * way to find out what *this* one is worth.
 */
export function buildVariantQuery(item, statIndex, helpers, rollPool, maxMods = MAX_VARIANT_MODS) {
  if (!item.name) return null;
  return buildOwnModsQuery(item, statIndex, helpers, { rollPool, maxMods, byName: true });
}

/**
 * Query built from the item's own modifiers.
 *
 * Used for two cases where `buildRareQuery`'s "similar gear" approach is wrong:
 *
 *  - uniques whose value is the roll (`byName: true` pins the name too);
 *  - rare jewels, which have no life or resistances to build pseudo-mods from
 *    and no equipment category. A jewel *is* its three modifiers, so searching
 *    for exactly those is what a person would do.
 */
export function buildOwnModsQuery(item, statIndex, helpers, opts = {}) {
  const { rollPool, maxMods = MAX_VARIANT_MODS, byName = false, fields, useCategory = false } = opts;
  const mods = helpers.rolledMods(statIndex, item, maxMods, rollPool, fields);
  if (!mods.length) return null;

  const filters = mods.map((mod) => {
    const filter = { id: mod.id };
    const value = mod.values[0];
    if (typeof value === 'number') {
      filter.value = { min: Math.floor(Math.abs(value) * SLACK) * Math.sign(value || 1) };
    }
    return filter;
  });

  const query = {
    status: { option: 'online' },
    stats: [{ type: 'and', filters }],
    filters: {
      misc_filters: { filters: { corrupted: { option: String(!!item.corrupted) } } },
    },
  };

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
  if (byName && item.name) query.name = item.name;

  return { query, sort: { price: 'asc' } };
}

const PSEUDO_RESISTANCE = 'pseudo.pseudo_total_elemental_resistance';
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
    status: { option: 'online' },
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
export async function fetchPrices(queryId, resultIds, chaosPerDivine) {
  const ids = resultIds.slice(0, 10);
  if (!ids.length) return [];

  await fetchLimit.take();

  const url = `${FETCH}/${ids.join(',')}?query=${encodeURIComponent(queryId)}`;
  const res = await fetch(url);
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
    if (price.currency === 'chaos') chaos.push(price.amount);
    else if (price.currency === 'divine' && chaosPerDivine) {
      chaos.push(price.amount * chaosPerDivine);
    }
  }
  return chaos.sort((a, b) => a - b);
}

/** Runs a search and returns its id and result ids, without opening anything. */
export async function runQuery(body, league) {
  await searchLimit.take();

  const res = await fetch(`${API}/${encodeURIComponent(league)}`, {
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
  return { id: data.id, result: data.result || [], total: data.total ?? 0 };
}

/** Runs a search and returns the trade page URL, ready to open. */
export async function search(item, league) {
  const body = buildQuery(item);
  if (!body) throw new Error("We can't build a search for this item yet.");
  const { id } = await runQuery(body, league);
  if (!id) throw new Error('Trade returned no search id.');
  return webUrl(league, id);
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
