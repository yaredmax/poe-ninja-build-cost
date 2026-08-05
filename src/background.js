import { buildPriceIndex, fetchLeagues } from './lib/economy.js';
import {
  buildQuery,
  buildRareQuery,
  buildComboQuery,
  combinations,
  DEFAULT_MIN_ROLL,
  minRollFor,
  searchUrl,
  setSaleMode,
  DEFAULT_SALE_MODE,
  SALE_MODES,
  fetchPrices,
  RELIABLE,
  isBetter,
  reliability,
  runQuery,
  webUrl,
} from './lib/trade.js';
import {
  GEAR_FIELDS,
  loadStatIndex,
  corruptedImplicits,
  mutatedMods,
  rolledMods,
  significantMods,
  totalElementalResistance,
  totalChaosResistance,
  totalLife,
} from './lib/stats.js';

/**
 * poe.ninja asks for a descriptive User-Agent identifying the app and a contact.
 * `fetch` refuses to set User-Agent, so we rewrite it with declarativeNetRequest.
 *
 * The `tabIds: [-1]` condition limits the rule to requests with no associated
 * tab, i.e. only the ones this service worker makes. That way we never touch the
 * requests the site itself makes while the user browses poe.ninja.
 * `tabIds` only exists on session rules, not on static manifest ones.
 *
 * ASCII only: an HTTP header with accents is invalid and gets rejected —
 * poe.ninja and Cloudflare both answer 403.
 */
const UA = `poe-ninja-build-cost/${chrome.runtime.getManifest().version} (personal build pricing extension; +https://github.com/yaredmax/poe-ninja-build-cost)`;
const UA_RULE_IDS = [1, 2];

// GGG asks for the same thing poe.ninja does.
const UA_TARGETS = [
  'https://poe.ninja/poe1/api/economy/',
  'https://www.pathofexile.com/api/trade/',
];

async function installUserAgentRule() {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: UA_RULE_IDS,
    addRules: UA_TARGETS.map((urlFilter, i) => ({
      id: UA_RULE_IDS[i],
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'User-Agent', operation: 'set', value: UA }],
      },
      condition: {
        urlFilter,
        tabIds: [-1], // chrome.tabs.TAB_ID_NONE
      },
    })),
  });
}

chrome.runtime.onInstalled.addListener(installUserAgentRule);
chrome.runtime.onStartup.addListener(installUserAgentRule);

/**
 * poe.ninja's URL slug ("allflame", "allflamehc") is not the league id the API
 * uses ("Allflame", "Hardcore Allflame"), so we generate each league's slug and
 * compare.
 */
function slugForLeague(id) {
  const hardcore = /^Hardcore (.+)$/.exec(id);
  if (hardcore) return `${hardcore[1].toLowerCase().replace(/\s+/g, '')}hc`;
  return id.toLowerCase().replace(/\s+/g, '');
}

/**
 * League to use. Accepts either the URL slug or an already-resolved id; if it
 * recognises neither, falls back to the current temporary league.
 */
async function resolveLeague(slug, id) {
  const leagues = await fetchLeagues();
  if (id && leagues.some((l) => l.id === id)) return id;
  if (slug) {
    const match = leagues.find((l) => slugForLeague(l.id) === slug.toLowerCase());
    if (match) return match.id;
  }
  return leagues[0]?.id ?? 'Standard';
}

/** Priority mods added on top of the pseudo ones in the fallback query. */
const FALLBACK_MODS = 1;

/**
 * Rare gear is searched by combination like the uniques, so these bound it.
 *
 * The mod cap keeps the combinatorics finite — with the property filters
 * absorbing added damage, attack speed and crit, real gear rarely gets near it.
 * The query budget is larger than a unique's because the search starts from the
 * full set, and a rare with every one of its modifiers pinned usually has no
 * listing at all: the first query is expected to miss.
 */
const GEAR_MAX_MODS = 6;
const GEAR_COMBO_QUERIES = 8;

/**
 * Most modifiers considered for a unique's permutation search.
 *
 * All of them, in practice. A unique's mod pool is fixed, and uniques are
 * searched with no minimum on the values (see `minRollFor`), so asking for every
 * modifier at once is asking "is it this unique" — which every copy answers yes
 * to. It costs nothing to be specific here and it buys the case we cannot see:
 * when poe.ninja does not expose a Foulborn's `mutatedMods`, the mutation is
 * still in the item's own modifier list, so searching all of them catches it
 * without having to know which one it is.
 */
const MAX_COMBO_MODS = 6;

/** Hard ceiling on searches for one item, whatever the maths says. */
const MAX_COMBO_QUERIES = 8;

/**
 * Prices an item by trying its modifiers, then every combination of one fewer,
 * and so on until the market has something.
 *
 * Taking the **most expensive** hit at a level is the point. The item carries
 * all of the modifiers, so it is worth at least as much as the priciest subset
 * that someone is actually selling. Any single subset is a lower bound; the
 * highest of them is the tightest one we can get.
 *
 * This replaces guessing which mods matter. There is no list of "valuable"
 * modifiers anywhere — Awakened PoE Trade doesn't have one either, it shows the
 * user checkboxes and lets them decide — so instead of guessing we measure.
 *
 * Most items resolve on the first or second query; the combinatorial tail only
 * runs for the awkward ones.
 */
async function priceByCombinations({
  item, mods, byName, league, chaosPerDivine, minRollPercent,
  useCategory = false, resistance = 0, chaos = 0, maxQueries = MAX_COMBO_QUERIES,
}) {
  const minRoll = minRollFor(item, minRollPercent);
  let budget = maxQueries;
  let widest = mods.length;

  for (let size = mods.length; size >= 1; size--) {
    const hits = [];
    for (const combo of combinations(mods, size)) {
      if (budget <= 0) break;
      const query = buildComboQuery(item, combo, {
        byName, minRoll, useCategory, resistance, chaos,
      });
      if (!query) continue;
      budget--;
      const attempt = await runQuery(query, league);
      if (attempt.total > 0) hits.push({ ...attempt, query, size });
    }
    if (!hits.length) continue;

    // Price each hit and keep the dearest.
    let best = null;
    for (const hit of hits) {
      const prices = await fetchPrices(hit.id, hit.result, chaosPerDivine, league);
      const median = prices.length ? prices[Math.floor(prices.length / 2)] : null;
      if (median != null && (!best || median > best.chaos)) best = { ...hit, chaos: median };
    }
    if (best) return { ...best, mods: size, rolled: widest, queriesUsed: maxQueries - budget };
  }
  return null;
}

/**
 * Appraisals are cached on the item's own GGG id, which is stable across page
 * loads, so refreshing a build costs nothing. This is what makes the trade pass
 * affordable: the second look at a build is free, and changing the roll slider
 * only re-prices what that slider actually affects.
 */
const APPRAISAL_TTL_MS = 2 * 60 * 60 * 1000;

function cacheKey(item, league, minRoll, saleMode, corruptedImplicits) {
  if (!item.id) return null;
  return `ap:${league}:${minRoll}:${saleMode}:${corruptedImplicits ? 1 : 0}:${item.id}`;
}

async function cachedAppraisal(key) {
  if (!key) return null;
  const store = await chrome.storage.local.get(key);
  const entry = store[key];
  if (!entry || Date.now() - entry.at > APPRAISAL_TTL_MS) return null;
  return { ...entry.data, cached: true };
}

async function cacheAppraisal(key, data) {
  if (!key) return;
  await chrome.storage.local.set({ [key]: { at: Date.now(), data } });
}

/** A trade link for any item, built without spending a request. */
async function linkFor(item, league, minRollPercent) {
  const simple = buildQuery(item);
  if (simple) return searchUrl(league, simple);

  // Rares and magic items have no name to search by, so we link the same query
  // the appraisal would run: its own modifiers at the configured roll.
  const index = await loadStatIndex();
  const useCategory = item.inventoryId !== 'PassiveJewels';
  const mods = rolledMods(index, item, MAX_COMBO_MODS, null, GEAR_FIELDS);
  const body = buildComboQuery(item, mods, {
    minRoll: minRollFor(item, minRollPercent),
    useCategory,
  });
  return body ? searchUrl(league, body) : null;
}

const handlers = {
  async ping() {
    return { ok: true };
  },

  /** Trade links for every item, so any badge can be clicked. Costs nothing. */
  async links({ items, league, minRollPercent, saleMode }) {
    setSaleMode(saleMode);
    const resolved = await resolveLeague(null, league);
    const urls = {};
    for (const item of items) {
      const url = await linkFor(item, resolved, minRollPercent);
      if (url) urls[item.index] = url;
    }
    return { urls };
  },

  async saleModes() {
    return { modes: SALE_MODES, current: DEFAULT_SALE_MODE };
  },

  async leagues() {
    return { leagues: await fetchLeagues() };
  },

  async prices({ leagueSlug }) {
    await installUserAgentRule(); // session rules are lost when the SW sleeps
    const league = await resolveLeague(leagueSlug);
    const { index, icons, failed, chaosPerDivine } = await buildPriceIndex(league);
    return { league, index, icons, failed, chaosPerDivine };
  },

  /**
   * Appraises a rare by searching trade for similar items. One search request
   * plus one fetch per item; the spacing is enforced by `runQuery`.
   */
  async appraise({
    item, rollPool, implicitPool, league, chaosPerDivine, minRollPercent, saleMode,
    matchCorruptedImplicits,
  }) {
    setSaleMode(saleMode);
    await installUserAgentRule();
    const resolved = await resolveLeague(null, league);

    const key = cacheKey(
      item,
      resolved,
      minRollPercent ?? DEFAULT_MIN_ROLL,
      saleMode ?? DEFAULT_SALE_MODE,
      matchCorruptedImplicits !== false,
    );
    const hit = await cachedAppraisal(key);
    if (hit) return hit;

    const result = await appraiseItem({
      item, rollPool, implicitPool, league: resolved, chaosPerDivine, minRollPercent,
      matchCorruptedImplicits,
    });
    await cacheAppraisal(key, result);
    return result;
  },

  async clearCache() {
    await chrome.storage.local.clear();
    return { ok: true };
  },
};

/** The actual work, split out so `appraise` can serve cached answers first. */
async function appraiseItem({
  item, rollPool, implicitPool, league: resolved, chaosPerDivine, minRollPercent,
  matchCorruptedImplicits,
}) {
  {
    const index = await loadStatIndex();

    const isUnique = item.frameType === 3 || item.frameType === 10;
    // A jewel has no life, no resistances and no equipment category, so the
    // "similar gear" query has nothing to work with. A jewel *is* its three
    // modifiers, so we search for exactly those.
    const isJewel = item.inventoryId === 'PassiveJewels';

    // Both are searched by their own mods. The unique also pins its name.
    if (isUnique || isJewel) {
      // A corruption implicit goes first: it is usually the reason one copy of
      // a unique costs many times what another does.
      const corrupted = matchCorruptedImplicits === false
        ? []
        : corruptedImplicits(index, item, implicitPool);
      // A Foulborn's mutation is the whole difference from the plain unique.
      const mutated = mutatedMods(index, item);
      const rolled = rolledMods(index, item, MAX_COMBO_MODS, rollPool);
      // Deduped: the three lists overlap. A corrupted Le Heup's implicit is
      // found by corruptedImplicits and again by rolledMods, and asking trade
      // for the same stat twice spends a filter slot to narrow nothing.
      const seen = new Set();
      const mods = mutated
        .concat(corrupted, rolled)
        .filter((mod) => !seen.has(mod.id) && seen.add(mod.id))
        .slice(0, MAX_COMBO_MODS);
      if (!mods.length) return { skipped: 'none of its mods could be translated' };

      const best = await priceByCombinations({
        item,
        mods,
        byName: isUnique,
        // Rare jewels come through here too, and `rolledMods` drops resistance
        // mods on the floor expecting a pseudo to carry them. Without these a
        // jewel whose whole value is resistance was searched on whatever else
        // it happened to roll.
        resistance: totalElementalResistance(item),
        chaos: totalChaosResistance(item),
        league: resolved,
        chaosPerDivine,
        minRollPercent,
      });
      // Nobody is selling this combination. For a unique there is still a
      // sensible answer — what the plain item goes for — and it is a true floor,
      // since the copy we are pricing has extra on top. Without this a corrupted
      // Tabula Rasa whose implicit nobody lists prices at nothing at all.
      if (!best && isUnique) {
        const plain = buildQuery(item);
        const attempt = plain ? await runQuery(plain, resolved) : null;
        if (attempt?.total) {
          const prices = await fetchPrices(attempt.id, attempt.result, chaosPerDivine, resolved);
          if (prices.length) {
            return {
              url: webUrl(resolved, attempt.id),
              total: attempt.total,
              chaos: prices[Math.floor(prices.length / 2)],
              reliability: 'variant',
              reliable: true,
              variant: true,
              partial: true, // the plain item, so a floor for this one
              mods: 0,
              rolled: mods.length,
              filters: [],
            };
          }
        }
      }
      if (!best) return { skipped: 'no listing found with any subset of its mods' };

      return {
        url: webUrl(resolved, best.id),
        total: best.total,
        chaos: best.chaos,
        reliability: 'variant',
        // This query is precise by construction — same item, same mods — so even
        // a single listing is a real answer. The lookalike gate doesn't apply.
        reliable: true,
        variant: true,
        // Priced on a subset of its modifiers, so the real value is at least
        // this much.
        partial: best.mods < best.rolled,
        mods: best.mods,
        rolled: best.rolled,
        queries: best.queriesUsed,
        filters: best.query.query.stats[0].filters.map((f) => f.id),
      };
    }

    // Rare gear, in two strategies within the same request budget as before.
    const helpers = { significantMods, totalElementalResistance, totalLife };
    let best = null;
    const consider = (attempt, body, strategy) => {
      if (!best || isBetter(attempt.total, best.total)) best = { ...attempt, body, strategy };
    };

    // 1) All of its modifiers, then every combination of one fewer, the same
    //    search the uniques get. Taking the first three in the order poe.ninja
    //    listed them meant a Void Sceptre was priced on fire damage, cast speed
    //    and crit while "+20% to Fire Damage over Time Multiplier" — the mod a
    //    fire build actually pays for — never reached the query, because it
    //    happened to be listed last.
    //
    //    The property filters are what makes this affordable: added damage,
    //    increased physical damage, attack speed and crit are already expressed
    //    by dps / pdps / edps / aps / crit, so they cost no filter slot and the
    //    combinatorics start from a much shorter list.
    const geared = rolledMods(index, item, GEAR_MAX_MODS, null, GEAR_FIELDS);
    if (geared.length) {
      const found = await priceByCombinations({
        item,
        mods: geared,
        byName: false,
        useCategory: true,
        resistance: totalElementalResistance(item),
        chaos: totalChaosResistance(item),
        maxQueries: GEAR_COMBO_QUERIES,
        league: resolved,
        chaosPerDivine,
        minRollPercent,
      });
      if (found) {
        return {
          url: webUrl(resolved, found.id),
          total: found.total,
          chaos: found.chaos,
          reliability: reliability(found.total),
          // Built from this item's own modifiers, so it is precise by
          // construction and one listing is a real answer.
          reliable: true,
          partial: found.mods < found.rolled,
          mods: found.mods,
          rolled: found.rolled,
          queries: found.queriesUsed,
          strategy: 'own-mods',
          filters: found.query.query.stats[0].filters.map((f) => f.id),
        };
      }
    }

    // 2) Fall back to pseudo life / resistances plus one priority mod, which is
    //    better for plain defensive gear whose individual mods are all common.
    //    Deliberately broad: step 1 already tried the specific route, so this
    //    one exists to find a market at all, and starting narrow would just burn
    //    a request on another empty result.
    if (!best || !RELIABLE.has(reliability(best.total))) {
      const query = buildRareQuery(item, index, helpers, FALLBACK_MODS);
      if (query) consider(await runQuery(query, resolved), query, 'pseudo');
    }

    if (!best) return { skipped: 'no filterable mods recognised' };

    const prices = best.total ? await fetchPrices(best.id, best.result, chaosPerDivine, resolved) : [];
    const rating = reliability(best.total);
    const byOwnMods = best.strategy === 'own-mods';

    return {
      url: webUrl(resolved, best.id),
      total: best.total,
      // Median of the ten cheapest: the single cheapest listing is nearly always
      // a joke price or a mislisted item.
      chaos: prices.length ? prices[Math.floor(prices.length / 2)] : null,
      reliability: rating,
      // The "too few results" gate guards the lookalike search, where a single
      // listing can be a fluke. A search built from the item's own modifiers is
      // precise, so one listing means "an item like this is on sale for X" —
      // which is exactly what we want to know.
      reliable: byOwnMods ? best.total > 0 : RELIABLE.has(rating),
      // We always filter on a subset of the item's mods, so whatever we find is
      // a floor rather than a valuation.
      partial: byOwnMods,
      strategy: best.strategy,
      filters: best.body.query.stats[0].filters.map((f) => f.id),
    };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) {
    sendResponse({ error: `Unknown message: ${msg?.type}` });
    return false;
  }
  handler(msg)
    .then((data) => sendResponse(data))
    .catch((err) => sendResponse({ error: String(err?.message || err) }));
  return true; // async response
});
