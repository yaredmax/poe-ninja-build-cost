import { buildPriceIndex, fetchLeagues } from './lib/economy.js';
import {
  attemptPlan,
  buildRareQuery,
  fetchPrices,
  RELIABLE,
  isBetter,
  reliability,
  runQuery,
  webUrl,
} from './lib/trade.js';
import {
  loadStatIndex,
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

/** How many mod filters the first appraisal attempt uses. */
const INITIAL_MODS = 2;

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
  async appraise({ item, league, chaosPerDivine }) {
    await installUserAgentRule();
    const resolved = await resolveLeague(null, league);
    const index = await loadStatIndex();

    const helpers = { significantMods, totalElementalResistance, totalLife };
    let body = buildRareQuery(item, index, helpers, INITIAL_MODS);
    if (!body) return { skipped: 'no filterable mods recognised' };

    let { id, result, total } = await runQuery(body, resolved);

    // Tune the filter count until the search is trustworthy, capped at two extra
    // attempts. We only keep an attempt if it improves things: spending another
    // request to make the estimate worse makes no sense.
    let adjusted = false;
    let width = body.query.stats[0].filters.length;
    for (const n of attemptPlan(total, INITIAL_MODS)) {
      if (RELIABLE.has(reliability(total))) break;
      const other = buildRareQuery(item, index, helpers, n);
      if (!other || other.query.stats[0].filters.length === width) continue;
      width = other.query.stats[0].filters.length;
      const attempt = await runQuery(other, resolved);
      if (isBetter(attempt.total, total)) {
        adjusted = true;
        body = other;
        ({ id, result, total } = attempt);
      }
    }

    const prices = total ? await fetchPrices(id, result, chaosPerDivine) : [];
    const rating = reliability(total);

    return {
      url: webUrl(resolved, id),
      total,
      // Median of the ten cheapest: the single cheapest listing is nearly always
      // a joke price or a mislisted item.
      chaos: prices.length ? prices[Math.floor(prices.length / 2)] : null,
      reliability: rating,
      reliable: RELIABLE.has(rating),
      adjusted,
      filters: body.query.stats[0].filters.map((f) => f.id),
    };
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
