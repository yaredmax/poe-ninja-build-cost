import { buildPriceIndex, fetchLeagues } from './lib/economy.js';
import {
  buildRareQuery,
  buildOwnModsQuery,
  fetchPrices,
  RELIABLE,
  isBetter,
  reliability,
  runQuery,
  searchLimit,
  fetchLimit,
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

/** Mod counts tried for a unique's variant search, most specific first. */
const VARIANT_MOD_STEPS = [3, 2, 1];

/** Same idea for rare gear, but two steps: the third search is the fallback. */
const GEAR_MOD_STEPS = [3, 2];

const handlers = {
  async ping() {
    return { ok: true };
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
  async appraise({ item, rollPool, league, chaosPerDivine }) {
    await installUserAgentRule();
    const resolved = await resolveLeague(null, league);
    const index = await loadStatIndex();

    const isUnique = item.frameType === 3 || item.frameType === 10;
    // A jewel has no life, no resistances and no equipment category, so the
    // "similar gear" query has nothing to work with. A jewel *is* its three
    // modifiers, so we search for exactly those.
    const isJewel = item.inventoryId === 'PassiveJewels';

    // Both are searched by their own mods. The unique also pins its name.
    if (isUnique || isJewel) {
      // Asking for every rolled mod at once describes a nearly unique item: the
      // test build's Watcher's Eye had zero listings on three mods and zero on
      // two, but ten on one — at 2 div against poe.ninja's 30 c floor. So we
      // step down until the market has something, and say when we had to.
      let best = null;
      let width = -1;
      for (const n of VARIANT_MOD_STEPS) {
        const query = buildOwnModsQuery(item, index, { rolledMods }, {
          rollPool,
          maxMods: n,
          byName: isUnique,
        });
        if (!query) continue;
        const filters = query.query.stats[0].filters.length;
        if (filters === width) continue; // fewer mods requested, same query
        width = filters;
        const attempt = await runQuery(query, resolved);
        best = { ...attempt, variant: query, mods: filters };
        if (attempt.total > 0) break;
      }
      if (!best) return { skipped: 'none of its mods could be translated' };

      const rolled = rolledMods(index, item, 99, rollPool).length;
      const prices = best.total
        ? await fetchPrices(best.id, best.result, chaosPerDivine)
        : [];
      return {
        url: webUrl(resolved, best.id),
        total: best.total,
        chaos: prices.length ? prices[Math.floor(prices.length / 2)] : null,
        reliability: best.total ? 'variant' : 'none',
        // Unlike the "similar rares" search this query is precise by
        // construction — same unique, same mods — so even two listings mean
        // something. The reliability gate for lookalikes doesn't apply.
        reliable: best.total > 0,
        variant: true,
        // We priced it on fewer mods than it actually has, so its real value is
        // at least this much.
        partial: best.mods < rolled,
        mods: best.mods,
        rolled,
        filters: best.variant.query.stats[0].filters.map((f) => f.id),
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
  },

  /** Seconds the queue will take, asked of the limiter's own bucket state. */
  async estimate({ count }) {
    // One search plus one fetch per item, and the search is the tight one.
    return { seconds: Math.max(searchLimit.estimate(count), fetchLimit.estimate(count)) };
  },

  async clearCache() {
    await chrome.storage.local.clear();
    return { ok: true };
  },
};

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
