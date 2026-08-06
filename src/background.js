import { buildPriceIndex, fetchLeagues } from './lib/economy.js';
import {
  buildQuery,
  buildRareQuery,
  buildComboQuery,
  combinations,
  DEFAULT_MIN_ROLL,
  minRollFor,
  isMutated,
  searchUrl,
  setSaleMode,
  DEFAULT_SALE_MODE,
  SALE_MODES,
  fetchPrices,
  medianPrice,
  RELIABLE,
  isBetter,
  reliability,
  runQuery,
  webUrl,
  searchLimit,
  fetchLimit,
  network,
} from './lib/trade.js';
import {
  GEAR_FIELDS,
  FLASK_FIELDS,
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

/**
 * Hard ceiling on searches for one item, whatever the maths says.
 *
 * Six, so the fallback can afford a whole level: dropping one modifier from six
 * is six queries, one per modifier. Stopping halfway would settle for whichever
 * subset happened to be tried first instead of the dearest, which is the entire
 * point of trying them.
 *
 * Narrowing the wide query to five modifiers would cap the worst case at six
 * searches instead of seven, and it was tried. It costs precision on every
 * jewel whose market *does* have the full combination — the majority — to save
 * one query on the few where it does not: a cluster jewel went from 56 c on six
 * filters to 40 c on five, and the pass total did not move at all.
 */
const MAX_COMBO_QUERIES = 6;

/**
 * Where an item's requests went, split by which half of the search spent them.
 *
 * The **wide** query — every modifier the item has, at once — is one search and
 * one fetch, and it is what nine items in ten cost. The **fallback** ladder is
 * everything below it: one query per subset, per level, and that is where the
 * time actually goes. **Broad** is the last resort that asks about something
 * other than this item's own modifiers — the plain unique, or the lookalike
 * search built from pseudo life and resistances.
 *
 * Kept because three separate attempts to speed the ladder up were judged on a
 * total that lumped all three together, on a fixture where the ladder never ran.
 * A number that does not separate them cannot tell you whether it improved.
 */
function newSpend() {
  return {
    wide: { searches: 0, fetches: 0 },
    fallback: { searches: 0, fetches: 0 },
    broad: { searches: 0, fetches: 0 },
    // Filled in by `appraiseItem`. `waiting` is time held by our own limiter,
    // `network` is time GGG had the request. A pass is slow for one reason or
    // the other and the fixes are opposite, so guessing between them is no good.
    ms: { total: 0, waiting: 0, network: 0 },
  };
}

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
  // Where to start the descent. The fallback passes one below the full set,
  // because the widest query has already been asked and answered.
  maxSize = null,
  // Accounting. `wide: false` says the top level of this descent is already
  // part of the fallback — the caller asked the wide question itself, or is
  // laddering a subset of the item's modifiers.
  spend = null, wide = true,
}) {
  const minRoll = minRollFor(item, minRollPercent);
  let budget = maxQueries;
  let widest = mods.length;

  const top = Math.min(maxSize ?? mods.length, mods.length);
  for (let size = top; size >= 1; size--) {
    const phase = wide && size === top ? 'wide' : 'fallback';
    const hits = [];
    for (const combo of combinations(mods, size)) {
      if (budget <= 0) break;
      const query = buildComboQuery(item, combo, {
        byName, minRoll, useCategory, resistance, chaos,
      });
      if (!query) continue;
      budget--;
      if (spend) spend[phase].searches++;
      const attempt = await runQuery(query, league);
      if (attempt.total > 0) hits.push({ ...attempt, query, size });
    }
    if (!hits.length) continue;

    // Price each hit and keep the dearest.
    let best = null;
    for (const hit of hits) {
      if (spend) spend[phase].fetches++;
      const prices = await fetchPrices(hit.id, hit.result, chaosPerDivine, league);
      const median = medianPrice(prices, hit.total);
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

/**
 * Everything about an item that changes what it is worth.
 *
 * Deliberately not its id. Two copies of the same jewel are two ids and were
 * appraised twice for the same answer — the search was free after the first,
 * because that is cached on the request body, but each still paid for its own
 * fetch. Keyed on what the item *is*, the second copy costs nothing, and so
 * does the same item met again on another character.
 *
 * `id` and `anchor` are excluded for exactly that reason; so is `index`, which
 * is just where it sat on the page.
 */
function fingerprint(item) {
  return JSON.stringify([
    item.name, item.baseType, item.frameType, item.inventoryId,
    !!item.corrupted, !!item.mutated, item.links ?? 0,
    item.gemLevel ?? null, item.gemQuality ?? 0,
    item.implicitMods, item.explicitMods, item.craftedMods,
    item.fracturedMods, item.enchantMods, item.mutatedMods,
    item.defences, item.weapon,
  ]);
}

/** FNV-1a. Not a security hash — just a short, stable key for storage. */
function hash32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function cacheKey(item, league, minRoll, saleMode, corruptedImplicits) {
  const shape = hash32(fingerprint(item));
  return `ap:${league}:${minRoll}:${saleMode}:${corruptedImplicits ? 1 : 0}:${shape}`;
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
  const isUnique = item.frameType === 3 || item.frameType === 10;
  // A corrupted or mutated unique needs its modifiers in the link too. The
  // by-name query would open a search for the plain unique, which is a
  // different item at a different price — the whole reason we appraise these.
  const altered = isUnique && (item.corrupted || isMutated(item));

  const simple = altered ? null : buildQuery(item);
  if (simple) return searchUrl(league, simple);

  if (altered) {
    const index = await loadStatIndex();
    const body = buildComboQuery(item, rolledMods(index, item, MAX_COMBO_MODS, null), {
      byName: true,
      minRoll: minRollFor(item, minRollPercent),
      resistance: totalElementalResistance(item),
      chaos: totalChaosResistance(item),
    });
    if (body) return searchUrl(league, body);
  }

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
    item, rollPool, implicitPool, basePool, league, chaosPerDivine, minRollPercent,
    saleMode, matchCorruptedImplicits,
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
      item, rollPool, implicitPool, basePool, league: resolved, chaosPerDivine,
      minRollPercent, matchCorruptedImplicits,
    });
    await cacheAppraisal(key, result);
    return result;
  },

  async clearCache() {
    await chrome.storage.local.clear();
    return { ok: true };
  },

  /**
   * What the rate limiter believes, for `pncReport()`.
   *
   * Costs nothing and answers the question a slow pass always raises: is the
   * wait GGG's policy, or the third of every bucket we hold back for the
   * player's own searches?
   */
  async limits() {
    // `rules` is the raw header, kept verbatim. Which of GGG's rules apply —
    // ip, account, client — depends on the request rather than on us, and a
    // report that does not say which ones were in force cannot explain a wait.
    const view = (limiter) => ({
      policy: limiter.policy,
      rules: limiter.rules,
      buckets: limiter.state(),
      waitedMs: limiter.waitedMs,
    });
    return { search: view(searchLimit), fetch: view(fetchLimit), networkMs: network.ms };
  },
};

/**
 * The actual work, split out so `appraise` can serve cached answers first.
 *
 * Every answer carries what it cost, including the ones that give up: an item
 * that spends seven searches to find nothing is exactly the case worth seeing.
 */
async function appraiseItem(args) {
  const spend = newSpend();
  const startedAt = Date.now();
  const waitedBefore = searchLimit.waitedMs + fetchLimit.waitedMs;
  const networkBefore = network.ms;

  const result = await runAppraisal({ ...args, spend });

  spend.ms = {
    total: Date.now() - startedAt,
    waiting: searchLimit.waitedMs + fetchLimit.waitedMs - waitedBefore,
    network: network.ms - networkBefore,
  };
  return { ...result, spend };
}

async function runAppraisal({
  item, rollPool, implicitPool, basePool, league: resolved, chaosPerDivine,
  minRollPercent, matchCorruptedImplicits, spend,
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
      const mutated = mutatedMods(index, item, basePool);
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

      // What actually varies between copies. A unique's explicit modifiers are
      // the same on every one of them, so dropping an explicit does not widen
      // the search by a single listing — permuting them is pure spend. Only the
      // corruption implicits, the mutation and the rolled variants distinguish
      // one copy from another, so those are the only ones worth laddering.
      //
      // The rolled ones count **only when poe.ninja published a roll pool**,
      // because that is what makes them rolled rather than fixed. Leaving them
      // out cost the item this whole path exists for: a Watcher's Eye rolls
      // three of eighty-seven modifiers, no copy on the market had the same
      // three, and with nothing to ladder it fell through to "any Watcher's
      // Eye" — ten thousand listings, median 2 c, for a jewel worth divines.
      const rolledArePool = !!rollPool?.length;
      const distinguishing = mutated
        .concat(corrupted, rolledArePool ? rolled : [])
        .filter((m) => mods.includes(m));

      // The widest query asks for everything, uniques included.
      //
      // It briefly did not. The argument was that a modifier every copy of a
      // unique carries cannot narrow a search by its name, so the fixed
      // explicits could come out and only the corruption, the mutation and the
      // pool-rolled modifiers needed asking for. A corrupted Winterweave
      // measured that way — six filters and one filter both returned the same
      // three listings — and `variantCount` was meant to protect the uniques
      // that are told apart by their explicits.
      //
      // A corrupted Grand Spectrum broke it. poe.ninja publishes no variants
      // for that jewel at all (`variantCount: 0`, and it does not even get the
      // base right), so the guard never fired, and "+1 to Minimum Power Charges
      // per Grand Spectrum" — the entire difference between one Grand Spectrum
      // and another — was dropped in favour of the corruption implicit alone.
      // It priced against every corrupted Grand Spectrum on the market,
      // including the cheap ones: 1297 c for a jewel whose uncorrupted twin
      // came out at 6118 c.
      //
      // The lesson is not about that guard. It is that one item is not a
      // measurement: "no published pool" does not mean "every copy carries
      // it", and there is no field in the economy data that reliably says
      // which it is. So everything the item has goes in, and the saving that
      // came from leaving some out goes away with it.
      const asked = mods;

      // One query with everything first: it is the precise one and it usually
      // hits, which is why a typical item costs one search and one fetch.
      let best = await priceByCombinations({
        item,
        mods: asked,
        byName: isUnique,
        maxQueries: 1,
        // Rare jewels come through here too, and `rolledMods` drops resistance
        // mods on the floor expecting a pseudo to carry them. Without these a
        // jewel whose whole value is resistance was searched on whatever else
        // it happened to roll.
        resistance: totalElementalResistance(item),
        chaos: totalChaosResistance(item),
        league: resolved,
        chaosPerDivine,
        minRollPercent,
        spend,
      });
      // Nothing sells with all of it — and when the reason is the corruption,
      // permuting is the wrong tool. Ask the same question once more without
      // the corruption implicits and with the corrupted filter off altogether,
      // which is trade's "any": every modifier the item rolled is still pinned,
      // and only "and it was corrupted this way" is relaxed.
      //
      // That is one query where the ladder spends six, and it keeps *more*
      // filters than any rung of the ladder does. A corrupted cluster jewel had
      // been spending seven searches and 160 seconds to arrive at nothing.
      //
      // It is a floor with a caveat rather than a floor: a corruption usually
      // adds value but it can subtract it, since a corrupted item cannot be
      // crafted further. Marked partial, like every other answer built from
      // less than the item has.
      //
      // **Not for uniques.** There the corruption implicit is the entire reason
      // the item came to trade at all — a Le Heup of All with "+1 to Maximum
      // Power Charges" against one without is 9 div against 7 c — so relaxing
      // it asks for the plain unique and lands on the floor this whole path
      // exists to beat. A unique keeps laddering its corruption implicits, and
      // the plain-unique query stays where it is, last.
      if (!best && !isUnique && corrupted.length && corrupted.length < mods.length) {
        const withoutCorruption = mods.filter((mod) => !corrupted.includes(mod));
        spend.broad.searches++;
        const query = buildComboQuery(item, withoutCorruption, {
          byName: isUnique,
          minRoll: minRollFor(item, minRollPercent),
          resistance: totalElementalResistance(item),
          chaos: totalChaosResistance(item),
          anyCorrupted: true,
        });
        const attempt = query ? await runQuery(query, resolved) : null;
        if (attempt?.total) {
          spend.broad.fetches++;
          const prices = await fetchPrices(attempt.id, attempt.result, chaosPerDivine, resolved);
          const median = medianPrice(prices, attempt.total);
          if (median != null) {
            best = {
              ...attempt,
              query,
              chaos: median,
              mods: withoutCorruption.length,
              rolled: mods.length,
            };
          }
        }
      }

      // Still nothing. Ladder the distinguishing modifiers alone
      // — for a double corruption that is two implicits which are each common
      // and together almost unheard of, so the pair finds nothing and each one
      // alone is a real answer. Dropping straight to these instead of permuting
      // the explicits is what makes it affordable: an Architect's Hand used to
      // spend its whole budget one level below the top, on subsets that were
      // never going to differ, and never reached a single implicit.
      //
      // A rare jewel has no distinguishing subset — every modifier it rolled is
      // its own — so it ladders over the most important few instead. That bound
      // is what keeps it affordable: at six modifiers, one level down is six
      // queries on its own, which is why jewels went slow. `count` cannot help
      // here, tempting as it looks: `count min 3 of 4` answers in one query but
      // pools every subset together, and the ten cheapest are then whichever
      // subset is junk — 1745 listings at 1 c where the per-subset ladder found
      // 100 c.
      //
      // Never empty. When a unique has nothing we can point at as varying —
      // no pool, no corruption, no mutation — its own modifiers are the only
      // thing left to ladder, and laddering them beats the alternative, which
      // is the price of the plain unique and therefore the floor we came here
      // to beat.
      const ladder = isUnique && distinguishing.length ? distinguishing : mods;
      if (!best && ladder.length) {
        const found = await priceByCombinations({
          item,
          mods: ladder,
          byName: isUnique,
          // Laddering a subset is a wider question than the one already asked,
          // so it starts at the top. Laddering the same set is not: that query
          // has been asked and answered, and repeating it spends a budget slot
          // to be told the same thing.
          maxSize: ladder === asked ? ladder.length - 1 : null,
          maxQueries: MAX_COMBO_QUERIES,
          resistance: totalElementalResistance(item),
          chaos: totalChaosResistance(item),
          league: resolved,
          chaosPerDivine,
          minRollPercent,
          // The widest query is already paid for above, so every search this
          // one makes belongs to the fallback, including its own top level.
          spend, wide: false,
        });
        // Measured against what the widest query asked for, so "2 of 2" means
        // the search pinned everything that distinguishes this copy — not a
        // floor — while "1 of 2" still marks it as one.
        if (found) best = { ...found, rolled: asked.length };
      }

      // The ladder's budget is one level wide and no deeper. Six queries is
      // exactly the six subsets of a six-modifier item at one fewer, so an item
      // whose market only exists two levels down spends everything and comes
      // back with nothing at all — a corrupted cluster jewel did precisely
      // that: seven searches, 160 seconds, no price.
      //
      // Rather than widen the budget for every item to rescue the rare one, ask
      // one deliberately small question at the end. Half the modifiers, in the
      // order they were already sorted into — which for a cluster jewel is its
      // notables and passive count first, the two things people actually shop
      // for. It is a floor and it is marked as one, and a floor beats the badge
      // saying nothing.
      //
      // Built from `rolled` and not from `mods`, and that distinction is the
      // whole thing. `mods` puts the corruption implicit first, so it survives
      // into every reduced set — and a cluster jewel with a corruption implicit
      // is exactly what nobody is selling. `rolled` is the jewel's own
      // modifiers in cluster order: notables, then the passive count. Asking
      // for the corruption here returned zero a second time; asking for the
      // notables is asking what a buyer would.
      if (!best && !isUnique && rolled.length > 2) {
        const few = rolled.slice(0, Math.ceil(rolled.length / 2));
        spend.broad.searches++;
        const query = buildComboQuery(item, few, {
          minRoll: minRollFor(item, minRollPercent),
          resistance: totalElementalResistance(item),
          chaos: totalChaosResistance(item),
        });
        const attempt = query ? await runQuery(query, resolved) : null;
        if (attempt?.total) {
          spend.broad.fetches++;
          const prices = await fetchPrices(attempt.id, attempt.result, chaosPerDivine, resolved);
          const median = medianPrice(prices, attempt.total);
          if (median != null) {
            best = {
              ...attempt, query, chaos: median, mods: few.length, rolled: mods.length,
            };
          }

        }
      }

      // Nobody is selling this combination. For a unique there is still a
      // sensible answer — what the plain item goes for — and it is a true floor,
      // since the copy we are pricing has extra on top. Without this a corrupted
      // Tabula Rasa whose implicit nobody lists prices at nothing at all.
      if (!best && isUnique) {
        const plain = buildQuery(item);
        if (plain) spend.broad.searches++;
        const attempt = plain ? await runQuery(plain, resolved) : null;
        if (attempt?.total) {
          spend.broad.fetches++;
          const prices = await fetchPrices(attempt.id, attempt.result, chaosPerDivine, resolved);
          if (prices.length) {
            return {
              url: webUrl(resolved, attempt.id),
              total: attempt.total,
              chaos: medianPrice(prices, attempt.total),
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
    const geared = rolledMods(
      index, item, GEAR_MAX_MODS, null,
      item.inventoryId === 'Flask' ? FLASK_FIELDS : GEAR_FIELDS,
    );
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
        spend,
      });
      if (found) {
        return {
          url: webUrl(resolved, found.id),
          total: found.total,
          chaos: found.chaos,
          reliability: reliability(found.total),
          // Built from this item's own modifiers, so the reliability table does
          // not apply at either end, and it counts.
          //
          // I briefly stopped trusting the loose end of it — a belt matched by
          // two hundred listings looked like filters that had narrowed nothing.
          // That reasoning belongs to the lookalike search below, which asks
          // for life and resistances and never mentions what the item is good
          // at, so its cheapest result says nothing. This search asks for the
          // item's own modifiers at 80% of its own rolls, so every one of those
          // two hundred is comparable or worse and the cheapest of them is a
          // genuine floor. Dropping it made the total *less* honest as a
          // minimum, which is what the total claims to be — and a build at
          // league start is mostly items like that.
          reliable: true,
          // Loose enough to be a floor rather than a price, though. The median
          // of the ten cheapest out of six hundred is the bottom of that pool,
          // not this item's worth, so it gets the `≥` that says so even when
          // every modifier made it into the query.
          partial: found.mods < found.rolled || reliability(found.total) === 'low',
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
      if (query) {
        spend.broad.searches++;
        consider(await runQuery(query, resolved), query, 'pseudo');
      }
    }

    if (!best) return { skipped: 'no filterable mods recognised' };

    if (best.total) spend.broad.fetches++;
    const prices = best.total ? await fetchPrices(best.id, best.result, chaosPerDivine, resolved) : [];
    const rating = reliability(best.total);
    // Always the pseudo lookalike by the time we get here: the own-mods search
    // returns above when it finds anything, and `consider()` — the only thing
    // that sets `best` — is only ever called with 'pseudo'. Kept as a named
    // constant rather than inlined because the two strategies genuinely differ
    // in how much a result is worth, and the next person to add a third one
    // needs to see that.
    const byOwnMods = best.strategy === 'own-mods';

    return {
      url: webUrl(resolved, best.id),
      total: best.total,
      // Median of the ten cheapest: the single cheapest listing is nearly always
      // a joke price or a mislisted item.
      chaos: medianPrice(prices, best.total),
      reliability: rating,
      // The "too few results" gate guards the lookalike search, where a single
      // listing can be a fluke. A search built from the item's own modifiers is
      // precise, so one listing means "an item like this is on sale for X" —
      // which is exactly what we want to know.
      //
      // But only that end of the scale. The bypass was written for `thin` and
      // quietly took `low` with it, so a rare flask matched by 1875 listings
      // was counted into the build total at 5 c — and 1875 listings is the
      // definition of filters that narrowed nothing, own modifiers or not. Both
      // ends of the table now mean what the table says; only the bottom is
      // waived.
      reliable: byOwnMods ? best.total > 0 && rating !== 'low' : RELIABLE.has(rating),
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
