import { buildPriceIndex, fetchLeagues } from './lib/economy.js';
import {
  buildQuery,
  buildRareQuery,
  buildComboQuery,
  buildOwnModsQuery,
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
  rolledMods,
  significantMods,
  totalElementalResistance,
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

/** Same idea for rare gear, but two steps: the third search is the fallback. */
const GEAR_MOD_STEPS = [3, 2];

/** Most modifiers considered for a permutation search. Bounds the combinatorics. */
const MAX_COMBO_MODS = 3;

/** Hard ceiling on searches for one item, whatever the maths says. */
const MAX_COMBO_QUERIES = 4;

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
async function priceByCombinations({ item, mods, byName, league, chaosPerDivine, minRollPercent }) {
  const minRoll = minRollFor(item, minRollPercent);
  let budget = MAX_COMBO_QUERIES;
  let widest = mods.length;

  for (let size = mods.length; size >= 1; size--) {
    const hits = [];
    for (const combo of combinations(mods, size)) {
      if (budget <= 0) break;
      const query = buildComboQuery(item, combo, { byName, minRoll });
      if (!query) continue;
      budget--;
      const attempt = await runQuery(query, league);
      if (attempt.total > 0) hits.push({ ...attempt, query, size });
    }
    if (!hits.length) continue;

    // Price each hit and keep the dearest.
    let best = null;
    for (const hit of hits) {
      const prices = await fetchPrices(hit.id, hit.result, chaosPerDivine);
      const median = prices.length ? prices[Math.floor(prices.length / 2)] : null;
      if (median != null && (!best || median > best.chaos)) best = { ...hit, chaos: median };
    }
    if (best) return { ...best, mods: size, rolled: widest, queriesUsed: MAX_COMBO_QUERIES - budget };
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

function cacheKey(item, league, minRoll, saleMode) {
  return item.id ? `ap:${league}:${minRoll}:${saleMode}:${item.id}` : null;
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
  async appraise({ item, rollPool, league, chaosPerDivine, minRollPercent, saleMode }) {
    setSaleMode(saleMode);
    await installUserAgentRule();
    const resolved = await resolveLeague(null, league);

    const key = cacheKey(item, resolved, minRollPercent ?? DEFAULT_MIN_ROLL, saleMode ?? DEFAULT_SALE_MODE);
    const hit = await cachedAppraisal(key);
    if (hit) return hit;

    const result = await appraiseItem({ item, rollPool, league: resolved, chaosPerDivine, minRollPercent });
    await cacheAppraisal(key, result);
    return result;
  },

  async clearCache() {
    await chrome.storage.local.clear();
    return { ok: true };
  },
};

/** The actual work, split out so `appraise` can serve cached answers first. */
async function appraiseItem({ item, rollPool, league: resolved, chaosPerDivine, minRollPercent }) {
  {
    const index = await loadStatIndex();

    const isUnique = item.frameType === 3 || item.frameType === 10;
    // A jewel has no life, no resistances and no equipment category, so the
    // "similar gear" query has nothing to work with. A jewel *is* its three
    // modifiers, so we search for exactly those.
    const isJewel = item.inventoryId === 'PassiveJewels';

    // Both are searched by their own mods. The unique also pins its name.
    if (isUnique || isJewel) {
      const mods = rolledMods(index, item, MAX_COMBO_MODS, rollPool);
      if (!mods.length) return { skipped: 'none of its mods could be translated' };

      const best = await priceByCombinations({
        item,
        mods,
        byName: isUnique,
        league: resolved,
        chaosPerDivine,
        minRollPercent,
      });
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

    // 1) The item's own modifiers, searched across its equipment category.
    //    This catches what the priority list misses — a Focused Amulet with
    //    "+2 to Level of all Physical Skill Gems" is defined by that mod, and no
    //    hand-written list will ever cover every such case.
    let width = -1;
    for (const n of GEAR_MOD_STEPS) {
      const query = buildOwnModsQuery(item, index, { rolledMods }, {
        maxMods: n,
        fields: GEAR_FIELDS,
        useCategory: true,
      });
      if (!query) continue;
      const filters = query.query.stats[0].filters.length;
      if (filters === width) continue;
      width = filters;
      consider(await runQuery(query, resolved), query, 'own-mods');
      if (RELIABLE.has(reliability(best.total))) break;
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

    const prices = best.total ? await fetchPrices(best.id, best.result, chaosPerDivine) : [];
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
