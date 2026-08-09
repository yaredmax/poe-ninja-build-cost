// Content script: finds the items poe.ninja has already rendered and puts a
// price next to each one.
//
// IMPORTANT — why this never calls poe.ninja's builds API:
// their documentation (https://poe.ninja/docs/api) states plainly that the
// builds / profiles / character endpoints are internal and NOT available for
// third-party use. So we don't touch them. We read what the page has already
// painted, which adds zero requests to poe.ninja and respects players who hide
// their profile: if the site doesn't show it, we don't see it either.

const PANEL_ID = 'pnc-panel';
const FAB_ID = 'pnc-fab';
const BADGE_CLASS = 'pnc-badge';

/**
 * Where the popup reads the run from.
 *
 * Not a `pnc-` name on purpose: check-wiring.mjs reads every `pnc-` string in
 * here as a CSS class content.css owes it, and a storage key is not one.
 */
const STATUS_KEY = 'pnc:status';

/**
 * User settings, from the options page. Re-read at the start of every run so a
 * change takes effect without reloading the page.
 *
 * They shape the trade queries: `minRollPercent` decides how good a listing has
 * to be to count as comparable, and `saleMode` decides which listings count at
 * all. Both are explained on the options page.
 */
let settings = { ...PNC_DEFAULTS };

/** Must stay identical to `normalizeName` in lib/economy.js — both sides match. */
function normalizeName(raw) {
  return String(raw)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // combining diacritics
    .replace(/[’'`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * The same build is reachable through three different routes:
 *   /poe1/builds/streamers/character/{account}/{character}
 *   /poe1/builds/{league}/character/{account}/{character}
 *   /poe1/profile/{account}/{league}/character/{character}
 * The only thing they share is the `/character/` segment, so that's what we test.
 */
function isCharacterPage() {
  return /^\/poe1\/(builds|profile)\/.*\/character\//.test(location.pathname);
}

/**
 * League slug from the URL when it's there. Streamer routes don't carry one,
 * and then we let the service worker fall back to the current league.
 */
function leagueSlugFromUrl() {
  const path = location.pathname;
  const builds = path.match(/^\/poe1\/builds\/([^/]+)\/character\//);
  if (builds && builds[1] !== 'streamers') return builds[1];
  const profile = path.match(/^\/poe1\/profile\/[^/]+\/([^/]+)\/character\//);
  if (profile) return profile[1];
  return null;
}

function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (res?.error) return reject(new Error(res.error));
      resolve(res);
    });
  });
}

// --------------------------------------------------------------- item classes

const isUnique = (item) => item.frameType === 3 || item.frameType === 10;
const isGem = (item) => item.frameType === 4;

const EQUIPMENT_SLOTS = new Set([
  'Helm', 'BodyArmour', 'Boots', 'Gloves', 'Weapon', 'Weapon2',
  'Offhand', 'Offhand2', 'Ring', 'Ring2', 'Amulet', 'Belt', 'Trinket',
]);

/**
 * The swap weapon set.
 *
 * It is not part of the build often enough to count by default: players park
 * spare Empowers and Enlightens in a second bow purely to level them, and the
 * character this was traced on had nine of them in there. So it stays out of
 * the total until asked for, and the panel only offers the switch on a build
 * that actually has one — an option that does nothing is worse than no option.
 */
const SWAP_SLOTS = new Set(['Weapon2', 'Offhand2']);

const isSwapSet = (match) => SWAP_SLOTS.has(match.item?.inventoryId);

/** In the panel and on the page, but deliberately out of the total. */
const isExcluded = (match) => isSwapSet(match) && !state.includeSwapSet;

/**
 * Section order in the summary, matching how poe.ninja lays the page out:
 * equipment first, then flasks under it, then the jewel blocks, then skills.
 *
 * Sorting by subtotal put the money first, which read well but meant the panel
 * shuffled itself between builds and never lined up with what was on screen.
 */
const SECTION_ORDER = ['Equipment', 'Flasks', 'Jewels', 'Gems', 'Other', 'Unpriced'];

/**
 * Category for the summary breakdown.
 *
 * With the bridge, the equipment slot is enough. The fallback path has no item
 * data — only the name of the price line — so we guess from the base type and
 * anything that doesn't fit lands in "Other".
 */
function categoryOf(match) {
  const item = match.item;
  if (item) {
    if (isGem(item)) return 'Gems';
    if (item.inventoryId === 'Flask') return 'Flasks';
    if (item.inventoryId === 'PassiveJewels') return 'Jewels';
    if (EQUIPMENT_SLOTS.has(item.inventoryId)) return 'Equipment';
    return 'Other';
  }
  if (match.price?.gems) return 'Gems';
  const base = match.price?.baseType || '';
  if (/\bjewel\b/i.test(base)) return 'Jewels';
  if (/\bflask\b/i.test(base)) return 'Flasks';
  return base ? 'Equipment' : 'Other';
}

/**
 * The slot, spelled the way a player says it.
 *
 * This is the row's second identity cue, after the icon: two 26px squares of
 * dark loot art look alike, and "Boots" tells them apart instantly. Which is
 * also why the micro-line is never dimmed below the readable grey.
 */
const SLOT_NAMES = {
  Helm: 'Helmet',
  BodyArmour: 'Body armour',
  Boots: 'Boots',
  Gloves: 'Gloves',
  Weapon: 'Weapon',
  Weapon2: 'Weapon II',
  Offhand: 'Offhand',
  Offhand2: 'Offhand II',
  Ring: 'Ring',
  Ring2: 'Ring',
  Amulet: 'Amulet',
  Belt: 'Belt',
  Flask: 'Flask',
  PassiveJewels: 'Jewel',
};

/**
 * Outside the equipment slots the label was the same word on every row: "Jewel"
 * nineteen times, "Gem" thirty. It identified the section, which the section
 * header already did, and nothing about the item.
 *
 * What replaces it is not invented — it is what GGG's own item JSON says. A gem
 * carries `support`, a boolean, so the two kinds separate without reading the
 * end of an English name. A jewel or a flask carries a `baseType` that is
 * exactly the distinction a player makes: `Cobalt Jewel`, `Medium Cluster
 * Jewel`, `Timeless Jewel`, `Silver Flask`.
 *
 * The equipment slots keep the slot. There it is already different on every row
 * and it is the word the player uses.
 */
const BASE_TYPE_SLOTS = new Set(['PassiveJewels', 'Flask']);

function slotOf(match) {
  const item = match.item;
  if (!item) return categoryOf(match) === 'Gems' ? 'Gem' : 'Item';
  if (isGem(item)) return item.support ? 'Support gem' : 'Skill gem';
  if (BASE_TYPE_SLOTS.has(item.inventoryId) && item.baseType) {
    // Unless it would only repeat the row's own name, which is what happens to
    // a flask nobody has renamed: the row already says "Quicksilver Flask".
    if (item.baseType !== displayName(match)) return item.baseType;
  }
  return SLOT_NAMES[item.inventoryId] || item.inventoryId || 'Item';
}

// --------------------------------------------------- primary path: page bridge

/** Asks the MAIN-world script for the real item JSON held by the page. */
function askBridge(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      resolve(null);
    }, timeoutMs);

    function onMessage(ev) {
      if (ev.source !== window || ev.data?.source !== 'pnc-bridge') return;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(ev.data.items || null);
    }

    window.addEventListener('message', onMessage);
    window.postMessage({ source: 'pnc-request' }, '*');
  });
}

/** Picks the price line matching this specific item. */
function priceForItem(item, index) {
  const entry = index[normalizeName(isGem(item) ? item.baseType : item.name)];
  if (!entry) return null;

  // A unique is its name *and* its base. Two can share a name: poe.ninja
  // publishes "Stormblood" only as a Sapphire Flask, at 20 c, and matching on
  // the name alone handed that price to a Stormblood Topaz Flask, which is a
  // different item they do not price at all. Better to admit we have no number
  // and let the trade pass find one — it searches name and base together.
  if (
    isUnique(item) && entry.baseType && item.baseType
    && normalizeName(entry.baseType) !== normalizeName(item.baseType)
  ) {
    return null;
  }

  if (isGem(item) && entry.gems?.length) {
    const { gemLevel: level, gemQuality: quality } = item;
    const exact = entry.gems.find(
      ([l, q, c]) => l === level && q === quality && c === (item.corrupted ? 1 : 0),
    );
    const sameLevel = entry.gems.filter(([l]) => l === level);
    const hit = exact || sameLevel[0];
    if (hit) return { ...entry, chaos: hit[3], variantCount: 0, detail: `${level}/${quality}` };
    return entry;
  }

  if (isUnique(item) && entry.uniq?.length) {
    const corrupted = item.corrupted ? 1 : 0;
    // Links, corruption and — for a Foulborn — which mutation. Ignoring the
    // last one collapsed every mutation sharing a link count into whichever
    // line came first, and on Null's Inclination those run from 3 c to 1562 c.
    const mutation = mutationKeyOf(item, index);
    const matches = (l, c, k) => l === item.links && c === corrupted && k === mutation;

    const exact = entry.uniq.find(([l, c, , k]) => matches(l, c, k));
    const sameMutation = entry.uniq.filter(([, , , k]) => k === mutation);
    const sameLinks = entry.uniq.filter(([l]) => l === item.links);
    const hit = exact || sameMutation[0] || sameLinks[0];
    if (hit) {
      return {
        ...entry,
        chaos: hit[2],
        // Still uncertain when we had to settle for a different link count or a
        // different mutation: those are genuinely other items.
        variantCount: exact ? 0 : entry.uniq.length,
        // Whether this is the published line for *this* copy, rather than the
        // nearest one. It decides whether trade has anything to add.
        variantMatched: Boolean(exact),
        detail: item.links >= 5 ? `${item.links}L` : null,
      };
    }
  }

  return entry;
}

function scanFromBridge(items, index) {
  const found = [];
  for (const item of items) {
    // No anchor means the page holds the item but is not painting it — the swap
    // weapon set while set I is the one on screen. That used to end the item's
    // journey here, which quietly undid the whole point of harvesting it: it can
    // be priced and listed perfectly well, it just has nowhere to put a badge
    // until poe.ninja mounts the set. An anchor that resolves to nothing is a
    // different story and still gets dropped.
    const el = item.anchor == null
      ? null
      : document.querySelector(`[data-pnc-item="${item.anchor}"]`);
    if (item.anchor != null && !el) continue;

    const price = priceForItem(item, index);
    // An unpriced unique is not the same as a rare. The rare *cannot* have a
    // price (random mods); the unique simply isn't in poe.ninja's economy — like
    // Skin of the Lords, which only exists corrupted and is worth whatever
    // keystone it rolled.
    const reason = price ? null : isUnique(item) ? 'unpriced' : 'random';
    found.push({ el, item, price, reason });
  }
  return found;
}

// ------------------------------------------------- fallback path: DOM scanning

/**
 * Texts that could be an item name, with the element to anchor the badge to.
 *
 * We deliberately avoid poe.ninja's CSS selectors: they're classes generated by
 * their Astro build and change on every deploy. Instead we compare the text
 * against the names we already know from the price index, which stays stable
 * even if the markup changes completely.
 */
function* textCandidates(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let el = walker.nextNode(); el; el = walker.nextNode()) {
    if (el.closest(`#${PANEL_ID}`)) continue;
    if (el.childElementCount !== 0) continue;
    const text = el.textContent?.trim();
    if (text && text.length >= 3 && text.length <= 60) yield { el, text };
  }
}

/**
 * In jewel lists poe.ninja writes "name + baseType" ("Watcher's Eye Prismatic
 * Jewel"). We try the whole text and then drop trailing words, but only when it
 * ends in a known base type: otherwise a randomly generated rare name could
 * match by pure chance.
 */
const BASE_SUFFIXES = /\b(jewel|flask|tincture|relic)$/i;

function lookupText(index, text) {
  const direct = index[normalizeName(text)];
  if (direct) return direct;
  if (!BASE_SUFFIXES.test(text.trim())) return null;

  const words = text.trim().split(/\s+/);
  for (let cut = words.length - 1; cut >= 1; cut--) {
    const hit = index[normalizeName(words.slice(0, cut).join(' '))];
    if (hit) return hit;
  }
  return null;
}

/** `.../b84147fcbd/AssassinationUnique2.png` -> `AssassinationUnique2.png` */
function artFilename(src) {
  if (!src) return null;
  const file = src.split('?')[0].split('/').pop();
  return file && file.endsWith('.png') ? file : null;
}

/**
 * Level and quality of a gem. In the DOM the name sits in its own <span> and
 * the "4 / 20" hangs off an ancestor, so we walk up a couple of levels and read
 * whatever follows the name.
 */
function gemLevelQuality(el, name) {
  for (let node = el.parentElement, depth = 0; node && depth < 3; node = node.parentElement, depth++) {
    const text = node.textContent.trim();
    if (!text.toLowerCase().startsWith(name.toLowerCase())) continue;

    // "Cast On Critical Strike Support (trigger) 20 / 20"
    const rest = text.slice(name.length).trim().replace(/^\([^)]*\)\s*/, '');

    // Anchored to the end on purpose. The DPS block repeats each skill name
    // followed by other figures ("Blade Blast 2.2/s · 900% crit"), and without
    // the anchor we would read "2" as the gem level.
    const m = rest.match(/^(\d+)(?:\s*\/\s*(\d+))?$/);
    if (m) return { level: Number(m[1]), quality: m[2] ? Number(m[2]) : 0 };
  }
  return null;
}

/**
 * Adjusts a gem's price to the level/quality shown on the page.
 *
 * Returns `null` when it is a gem and no level is readable: that means we're
 * not in the skills list but in the DPS block, which repeats the same names.
 * Without this, every gem in the main setup would be counted twice.
 */
function refineGem(entry, el) {
  if (!entry.gems?.length) return entry;
  const lq = gemLevelQuality(el, entry.name);
  if (!lq) return null;

  const exact = entry.gems.find(([lvl, q]) => lvl === lq.level && q === lq.quality);
  const sameLevel = entry.gems.filter(([lvl]) => lvl === lq.level);
  const hit = exact || sameLevel[0];
  if (!hit) return entry;

  return { ...entry, chaos: hit[3], variantCount: 0, detail: `${lq.level}/${lq.quality}` };
}

/** Drops overlapping anchors: if a parent or child is already marked, skip. */
function overlaps(accepted, el) {
  return accepted.some((m) => m.el === el || m.el.contains(el) || el.contains(m.el));
}

/**
 * Scan root: the `<article>` holding the character sheet.
 *
 * Scoping is essential. The footer carries the cookie consent dialog with
 * hundreds of ad vendor names, and some of them ("Impact", "Momentum",
 * "Signal") collide with real PoE item names. Scanning the whole `document.body`
 * puts invented prices in the summary.
 */
function scanRoot() {
  return document.querySelector('article') || document.body;
}

/** Is the same item already matched inside the same card as `el`? */
function alreadyInCard(found, el, name) {
  let node = el;
  for (let depth = 0; node && depth < 4; node = node.parentElement, depth++) {
    if (found.some((m) => m.price.name === name && node.contains(m.el))) return true;
  }
  return false;
}

function scanItems(index, icons) {
  const found = [];
  const root = scanRoot();

  // 1) by text: jewels, gems and everything poe.ninja spells out in words
  for (const { el, text } of textCandidates(root)) {
    const entry = lookupText(index, text);
    if (!entry) continue;
    if (overlaps(found, el)) continue;
    const price = refineGem(entry, el);
    if (!price) continue;
    found.push({ el, price });
  }

  // 2) by icon: equipment is drawn as images only, with no name in the DOM
  for (const img of root.querySelectorAll('img[src*="poecdn"]')) {
    if (img.closest(`#${PANEL_ID}`)) continue;
    const key = icons[artFilename(img.getAttribute('src'))];
    const entry = key && index[key];
    if (!entry) continue;
    if (overlaps(found, img)) continue;
    // A gem's icon and its name live in sibling elements, so `overlaps` doesn't
    // see them as the same item and we would count it twice.
    if (alreadyInCard(found, img, entry.name)) continue;
    found.push({ el: img, price: entry, viaIcon: true });
  }

  return found;
}

// ------------------------------------------------------------------ formatting

function formatChaos(chaos, chaosPerDivine) {
  if (chaos == null) return '—';
  if (chaosPerDivine && chaos >= chaosPerDivine) {
    return `${(chaos / chaosPerDivine).toFixed(1)} div`;
  }
  return `${chaos < 10 ? chaos.toFixed(1) : Math.round(chaos)} c`;
}

/**
 * The same number, sized to fit over an item tile.
 *
 * **The unit is never dropped.** It was, on any tile under 80px — which on a
 * real character page is every flask, every cluster jewel and every base jewel,
 * so most of the grid — and a bare `8.0` could be eight chaos or eight divine
 * with nothing on screen to say which. The number stops meaning anything at
 * that point, which is worse than the badge being a few pixels wider.
 *
 * So badges use the one-letter unit everywhere, `87.1d` and `10c`, the way a
 * player writes it in a trade whisper. It is the same width in a 46px corner as
 * in a 98px one, so there is nothing left for `compact` to decide here — it
 * still governs the qualifier (`6L`) in `paintBadge`, which really does not fit.
 * The panel has room and spells `div` and `c` out in full.
 *
 * Above a thousand divine the decimal is noise, and dropping it buys back the
 * character the unit costs.
 *
 * A trailing `.0` goes too: `52.0d` is not more precise than `52d`, it is two
 * characters wider for nothing, and across a grid of thirty badges those two
 * characters are the difference between a column and a mess.
 */
const trimZero = (text) => text.replace(/\.0$/, '');

function formatBadgeAmount(chaos, chaosPerDivine) {
  if (chaos == null) return '—';
  if (chaosPerDivine && chaos >= chaosPerDivine) {
    const div = chaos / chaosPerDivine;
    return `${div >= 1000 ? Math.round(div) : trimZero(div.toFixed(1))}d`;
  }
  return `${chaos < 10 ? trimZero(chaos.toFixed(1)) : Math.round(chaos)}c`;
}

/** Seconds as the panel says them: "~3 min left", "~45 s left". */
function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 90) return `~${Math.max(5, Math.round(seconds / 5) * 5)} s left`;
  return `~${Math.round(seconds / 60)} min left`;
}

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} m ${String(seconds % 60).padStart(2, '0')} s`;
}

/** Names come from poe.ninja but end up in innerHTML, so they get escaped. */
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function displayName(match) {
  const item = match.item;
  if (item) return item.name || item.baseType || item.typeLine || 'Item';
  return match.price?.name || 'Item';
}

// ---------------------------------------------------------------- price model
//
// One function decides what a match is worth and how much to trust it, and
// everything on screen reads from it: the badge over the item, the chip in the
// row, the subtotals, the grand total and the footnotes. When the badge and the
// panel disagreed it was always because two places were deciding this
// separately.

/**
 * `kind` is what the colour says — how much to trust the number:
 *   firm     counts in full
 *   floor    counts as a minimum (`≥` or `±`)
 *   unknown  no usable number, out of the total
 */
function priceOf(match) {
  const a = match.appraisal;

  if (a && a.chaos && a.reliable) {
    return {
      chaos: a.chaos,
      symbol: a.partial ? '≥' : '≈',
      kind: a.partial ? 'floor' : 'firm',
      source: 'trade',
    };
  }

  // Trade found nothing usable. A `≥` unique keeps poe.ninja's floor: a floor
  // is still more informative than a question mark.
  if (match.price && typeof match.price.chaos === 'number') {
    const floor = match.price.floor || match.price.variantCount > 1;
    return {
      chaos: match.price.chaos,
      symbol: match.price.floor ? '≥' : match.price.variantCount > 1 ? '±' : '',
      kind: floor ? 'floor' : 'firm',
      source: 'ninja',
      detail: match.price.detail || null,
    };
  }

  return { chaos: null, symbol: '?', kind: 'unknown', source: a ? 'trade' : 'none' };
}

/** Still waiting on trade, so whatever is shown is provisional. */
function isPending(match) {
  return Boolean(match.queued) && !match.appraisal && !match.failed;
}

/**
 * The one fact that explains the price, for the row's micro-line.
 *
 * Deliberately one fact and not a summary: the row has 200px for it and the
 * full story is a click away in the (i).
 */
function microFact(match, group) {
  if (isPending(match)) return match === state.current ? 'pricing now' : 'in queue';
  if (group && group.count > 1) {
    const each = priceOf(match).chaos;
    if (each != null) return `${formatChaos(each, state.chaosPerDivine)} each`;
  }

  const a = match.appraisal;
  if (a && a.chaos && a.reliable) {
    if (a.partial && a.rolled) return `${a.mods} of ${a.rolled} mods`;
    return `${a.total} listing${a.total === 1 ? '' : 's'}`;
  }
  if (a && a.skipped) return 'no comparable listing';
  if (a && a.chaos && !a.reliable) {
    return a.total > 120 ? 'too many similar items' : 'too few similar items';
  }

  if (match.reason === 'unpriced') return 'not in the economy';
  if (!match.price) return 'no market price';
  if (match.price.variantCount > 1) return `${match.price.variantCount} variants published`;
  if (match.price.floor) return 'cheapest roll published';
  return 'poe.ninja';
}

/**
 * The full explanation. This is the badge's `title` and the body of the (i)
 * tooltip, written once so the two can never say different things.
 */
function reasonFor(match) {
  const a = match.appraisal;
  const name = displayName(match);

  if (isPending(match)) {
    return 'Checking this exact copy on trade. The number shown is '
      + "poe.ninja's price for the plain item until then.";
  }

  if (a && a.chaos && a.reliable) {
    if (a.variant) {
      if (a.mods === 0) {
        return 'Nobody is selling one with the modifiers this copy rolled. '
          + `${a.total} listing(s) of the plain item, cheapest median — this one is `
          + 'worth at least that.';
      }
      return `${a.total} listing(s) matching ${a.mods} of the ${a.rolled} `
        + 'modifier(s) searched for, cheapest median.'
        // One listing is a real answer for a query this precise, but it is one
        // person's item: take it and the search behind this number is empty.
        + (a.total === 1 ? ' Only one was listed, so it may already be sold.' : '')
        + (match.price ? " Replaces poe.ninja's published price." : '')
        + (a.partial ? ' Priced on fewer mods than it has, so it is worth at least this.' : '');
    }
    return `Median of the cheapest listings among ${a.total} similar items. `
      + `Reliability: ${a.reliability}.`
      + (a.adjusted ? ' Filter count was adjusted to find a usable result.' : '');
  }

  // An unreliable number is worse than none. A rare helmet showing "1 c" reads
  // as a price, when all it means is that 158 helmets matched filters that
  // narrowed nothing down. The figure stays here, not on the icon.
  if (a && a.chaos && !a.reliable) {
    return `${a.total} similar items matched — ${a.total > 120 ? 'far too many' : 'too few'} to `
      + 'estimate from. For reference the cheapest were around '
      + `${formatChaos(a.chaos, state.chaosPerDivine)}, but that is not this item's price and is `
      + 'excluded from the total.';
  }

  const noListing = a?.skipped ? ` No listing with these mods was found on trade (${a.skipped}).` : '';

  if (match.price?.floor) {
    return `${name}: the price depends on the item's roll. poe.ninja only publishes the `
      + `cheapest one, so this is a floor, not its value.${noListing}`;
  }
  if (match.price?.variantCount > 1) {
    const [min, max] = match.price.spread || [];
    return `${name}: ${match.price.variantCount} variants`
      + (min ? ` (${Math.round(min)}c – ${Math.round(max)}c depending on which)` : '')
      + `. Showing the best-selling one, which need not be this one.${noListing}`;
  }
  if (match.price) {
    return `${name} — ${match.price.listings} listings on poe.ninja.${noListing}`;
  }
  if (match.reason === 'unpriced') {
    return `${name}: poe.ninja publishes no price for this unique. It can be worth a lot, and `
      + `it does not count towards the total.${noListing}`;
  }
  return `${name}: random mods, so no market price for this exact item exists.${noListing}`;
}

/** The tooltip's headline: the answer, before the reasoning. */
function headlineFor(match) {
  const { chaos, kind } = priceOf(match);
  if (isPending(match)) return 'Still pricing on trade';
  if (kind === 'unknown') return 'No usable number';
  const amount = formatChaos(chaos, state.chaosPerDivine);
  return kind === 'floor' ? `Worth at least ${amount}` : `Worth ${amount}`;
}

// ----------------------------------------------------------------- run state

/**
 * Everything the five surfaces read from. Held in one object rather than in the
 * DOM: the panel is rebuilt in pieces as prices land, and reading the current
 * total back out of a text node is how the badge and the panel came to disagree.
 */
const state = {
  phase: 'idle', // idle | reading | ninja | trading | paused | stopped | done | error
  matches: [],
  groups: [],
  sections: null,
  chaosPerDivine: 0,
  league: null,
  failed: null,
  source: null,
  queue: [],
  done: 0,
  current: null,
  waitedSeconds: 0,
  startedAt: 0,
  finishedAt: 0,
  elapsed: [], // ms per finished item, for the estimate
  searches: 0,
  fromCache: 0,
  collapsed: false,
  // Per build, not a saved preference: it answers "does *this* character's swap
  // set matter", which is a different question on every character. The settings
  // that apply to everything live in the popup and the options page.
  includeSwapSet: false,
  legendOpen: false,
  openTip: null,
  notSignedIn: false,
  blockedUntil: 0,
  error: null,
};

function resetState() {
  Object.assign(state, {
    phase: 'idle',
    matches: [],
    groups: [],
    sections: null,
    chaosPerDivine: 0,
    league: null,
    failed: null,
    source: null,
    queue: [],
    done: 0,
    current: null,
    waitedSeconds: 0,
    startedAt: 0,
    finishedAt: 0,
    elapsed: [],
    searches: 0,
    fromCache: 0,
    openTip: null,
    notSignedIn: false,
    blockedUntil: 0,
    error: null,
  });
}

/** Seconds left, from what the pass has actually cost so far. */
function etaSeconds() {
  const left = state.queue.length - state.done;
  if (left <= 0 || state.elapsed.length < 2) return 0;
  const mean = state.elapsed.reduce((s, ms) => s + ms, 0) / state.elapsed.length;
  return Math.round((mean * left) / 1000);
}

/**
 * What the toolbar popup shows. Written on phase changes and after each item,
 * not on every tick: the popup asks "is it still working?", and that answer does
 * not change ten times a second.
 */
function publishStatus() {
  const totals = totalsOf();
  const payload = {
    phase: state.phase,
    done: state.done,
    total: state.queue.length,
    etaSeconds: etaSeconds(),
    current: state.current ? displayName(state.current) : null,
    chaos: totals.chaos,
    chaosPerDivine: state.chaosPerDivine,
    at: Date.now(),
  };
  try {
    chrome.storage?.local?.set({ [STATUS_KEY]: payload });
  } catch {
    // An orphaned content script has no storage. Nothing here is worth
    // breaking the panel over.
  }
}

// ---------------------------------------------------------------- the badges

function clearBadges() {
  document.querySelectorAll(`.${BADGE_CLASS}`).forEach((n) => n.remove());
}

/**
 * Container to pin a corner badge to: the icon cell.
 *
 * We walk up from the anchor looking for something icon-sized. If there isn't
 * one (a text list, say) we return null and the badge is right-aligned in the
 * row instead.
 */
function iconContainer(el) {
  let node = el.tagName === 'IMG' ? el.parentElement : el;
  for (let i = 0; i < 4 && node; i++, node = node.parentElement) {
    const r = node.getBoundingClientRect();
    if (r.width >= 40 && r.height >= 40) return node;
  }
  return null;
}

/**
 * Shrinks the number until the badge fits its tile.
 *
 * The alternative was a common minimum width, which reads well in a mockup
 * where every tile is the same and badly on poe.ninja, where a helmet is 98px
 * and a ring is 46px: one width leaves `10c` marooned in a slab of padding on
 * the big tiles and hangs off both sides of the small ones. So the box stays as
 * small as the number allows and the *number* gives way, which is the thing
 * that can afford to.
 *
 * Only ever downwards, and never below 8.5px, where a price stops being worth
 * printing. Cached against the text, because the fit costs a layout read and
 * a price changes at most twice in a run — once from poe.ninja, once from trade.
 */
const MIN_BADGE_PX = 8.5;

function fitBadge(badge) {
  const text = badge.textContent;
  if (badge.dataset.pncFit === text) return;
  badge.dataset.pncFit = text;

  const tile = badge.offsetParent;
  if (!tile || !badge.classList.contains('pnc-badge--corner')) return;

  badge.style.fontSize = '';
  const natural = badge.getBoundingClientRect().width;
  // The badge is anchored past the corner on purpose, so a little overhang is
  // the design rather than a failure to fit.
  const room = tile.getBoundingClientRect().width + 8;
  if (!natural || natural <= room) return;

  const base = parseFloat(getComputedStyle(badge).fontSize);
  badge.style.fontSize = `${Math.max(MIN_BADGE_PX, (base * room) / natural).toFixed(2)}px`;
}

/**
 * Places the badge. Equipment, jewels and flasks get it overlaid outside the
 * bottom-right corner of the icon, where it covers nothing.
 *
 * Gems are a text list, and the price goes straight after the name with 6px of
 * air — nothing cleverer. Two attempts at appending it to "the gem's row" so
 * the prices would form a column both ended with the price on a line of its
 * own below the name, which in a list of twenty gems leaves you counting rows
 * to work out whether a number belongs to the gem above it or below. Measured
 * on a live character: sixteen of seventeen gems keep the badge on the name's
 * line this way, with at least 103px still spare in the cell.
 */
function placeBadge(match, badge) {
  const isText = categoryOf(match) === 'Gems';
  const corner = !isText && iconContainer(match.el);

  if (corner) {
    if (getComputedStyle(corner).position === 'static') corner.style.position = 'relative';
    badge.classList.add('pnc-badge--corner');
    // Below about 80px the qualifier is a third of the badge. A cluster jewel
    // tile has no room for it; the unit stays, it is one character.
    if (corner.getBoundingClientRect().width < 80) badge.classList.add('pnc-badge--small');
    corner.appendChild(badge);
  } else {
    badge.classList.add('pnc-badge--inline');
    match.el.insertAdjacentElement('afterend', badge);
  }

  // Keep the reference: corner badges are not siblings of the anchor, so the
  // trade pass could not find them again to update the price.
  match.badge = badge;
}

/** Builds or refreshes the badge over one item. */
function paintBadge(match) {
  // Nothing on screen to badge. True of the swap set until you press "II" on
  // poe.ninja, at which point the re-harvest gives the item an anchor and the
  // badge appears on the next paint.
  if (!match.el) return;

  let badge = match.badge;
  if (!badge) {
    badge = document.createElement('span');
    badge.className = BADGE_CLASS;
    placeBadge(match, badge);
    // Both directions: hovering a badge lights its row, hovering a row rings
    // its badge. With 25 badges on screen there is no other way to tell which
    // is which.
    badge.addEventListener('mouseenter', () => setHover(match.group, true));
    badge.addEventListener('mouseleave', () => setHover(match.group, false));
  }

  const compact = badge.classList.contains('pnc-badge--small');
  const { chaos, symbol, kind, detail } = priceOf(match);
  const pending = isPending(match);
  const pricing = match === state.current;
  // A gem's qualifier is its level and quality, and poe.ninja has already
  // written `21 / 20` in the same row a centimetre away. Repeating it says
  // nothing and takes the width the price needs. `6L` on a weapon has no such
  // twin on the page, so that one stays.
  const echoesThePage = categoryOf(match) === 'Gems';

  badge.classList.remove(
    'pnc-badge--floor', 'pnc-badge--unknown', 'pnc-badge--pending', 'pnc-badge--working',
    'pnc-badge--skipped',
  );
  badge.textContent = '';

  /*
   * Set II, switched off. Leaving the corner blank would read as "we could not
   * price this", which is the one thing it does not mean — so the badge says
   * the item was left out and how to change that, in the place the price would
   * have been. It is not a link to a search, so any old one is cleared.
   */
  if (isExcluded(match)) {
    badge.classList.add('pnc-badge--skipped');
    badge.textContent = 'set II';
    badge.title = 'Not counted: the swap weapon set is usually storage. '
      + 'Turn it on under the total to price it.';
    // It may have been priced a moment ago, under the switch turned back off.
    // The number goes, so the link to the search behind it has to go too.
    badge.dataset.searchUrl = '';
    badge.classList.remove('pnc-badge--link');
    fitBadge(badge);
    return;
  }

  /*
   * The item being priced on trade right this second. It used to blank to an
   * empty grey box, which reads as "no information" over an item that in most
   * cases already has poe.ninja's number on it — we were hiding what we knew to
   * say we were busy. So the number stays and the badge takes the working
   * style; only where there is genuinely nothing yet, a rare with no published
   * price, does it fall back to `··`, which is what the legend already calls
   * "still pricing".
   */
  if (pricing) {
    badge.classList.add('pnc-badge--working');
    badge.textContent = chaos == null
      ? '··'
      : (symbol ? `${symbol} ` : '') + formatBadgeAmount(chaos, state.chaosPerDivine);
    badge.title = chaos == null
      ? 'Pricing this item on trade right now.'
      : "Pricing this item on trade right now. This is poe.ninja's number until it lands.";
    fitBadge(badge);
    return;
  }

  if (kind === 'unknown') {
    badge.classList.add(pending ? 'pnc-badge--pending' : 'pnc-badge--unknown');
    badge.textContent = '?';
  } else {
    if (pending) badge.classList.add('pnc-badge--pending');
    else if (kind === 'floor') badge.classList.add('pnc-badge--floor');
    badge.textContent = (symbol ? `${symbol} ` : '')
      + formatBadgeAmount(chaos, state.chaosPerDivine);
    if (detail && !compact && !echoesThePage) {
      const qual = document.createElement('span');
      qual.className = 'pnc-badge-qual';
      qual.textContent = detail;
      badge.appendChild(qual);
    }
  }

  fitBadge(badge);
  badge.title = reasonFor(match);
  linkToSearch(badge, match.appraisal?.url || match.searchUrl);
}

function paintBadges() {
  for (const match of state.matches) paintBadge(match);
}

/**
 * Makes a badge open the very search that produced its number.
 *
 * GGG's search ids are durable, so the link shows exactly the listings the
 * price came from — no re-running the query, and no way for it to disagree with
 * what we displayed.
 *
 * Corner badges are `pointer-events: none` so they don't cover poe.ninja's item
 * tooltip; a clickable one has to opt back in, which costs the tooltip on that
 * small corner. Worth it for being able to check the number.
 */
function linkToSearch(badge, url) {
  if (!url) return;

  // A badge gets linked twice: once when the economy pass paints it, and again
  // when its trade appraisal comes back with a better search. Only the URL
  // changes — attaching a second listener opened two tabs on one click.
  badge.dataset.searchUrl = url;
  if (badge.dataset.linked) return;
  badge.dataset.linked = '1';

  badge.classList.add('pnc-badge--link');
  badge.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    // The listener outlives the URL: a badge that has been emptied again — the
    // swap set switched back off — would otherwise open a blank tab.
    if (!badge.dataset.searchUrl) return;
    // Straight from the click, with no await in between, or Chrome treats it as
    // a popup and blocks it.
    window.open(badge.dataset.searchUrl, '_blank', 'noopener');
  });
}

function setHover(group, on) {
  if (!group) return;
  group.row?.classList.toggle('pnc-row--open', on || state.openTip === group.key);
  for (const member of group.members) {
    member.badge?.classList.toggle('pnc-badge--ring', on);
  }
}

// ------------------------------------------------------------- the row model

/**
 * Identity for grouping. Nine identical Raise Spectre are one line, not nine —
 * but only when they really are identical, because two copies of the same jewel
 * with different rolls are two prices.
 *
 * Deliberately not the price: grouping has to be decided before anything is
 * priced, or rows would merge and split under the reader as the pass ran.
 */
function groupKey(match) {
  const item = match.item;
  const parts = [categoryOf(match), displayName(match)];
  if (item) {
    parts.push(
      item.baseType, item.frameType, item.links, item.corrupted ? 1 : 0,
      item.gemLevel, item.gemQuality, (item.explicitMods || []).join('~'),
    );
  }
  return parts.join('|');
}

function buildGroups(matches) {
  const byKey = new Map();
  for (const match of matches) {
    const key = groupKey(match);
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        category: categoryOf(match),
        name: displayName(match),
        slot: slotOf(match),
        members: [],
        count: 0,
      };
      byKey.set(key, group);
    }
    group.members.push(match);
    group.count++;
    match.group = group;
  }
  return [...byKey.values()];
}

/** A group's contribution to the total: one member's price times the count. */
function groupPrice(group) {
  const head = group.members[0];
  const { chaos, kind, symbol } = priceOf(head);
  return {
    kind,
    symbol,
    chaos: chaos == null ? null : chaos * group.count,
    pending: group.members.some(isPending),
    pricing: group.members.some((m) => m === state.current),
  };
}

function totalsOf() {
  let chaos = 0;
  let priced = 0;
  let provisional = 0;
  let unknown = 0;
  let units = 0;
  const sections = new Map();

  for (const group of state.groups) {
    // Left out on purpose. It is not unpriced — counting it as such would put
    // "1 item is not in the total" under a build where nothing failed.
    if (group.members.every(isExcluded)) continue;
    units += group.count;

    const price = groupPrice(group);
    if (price.pending) provisional += group.count;

    if (price.kind === 'unknown') {
      unknown += group.count;
    } else {
      chaos += price.chaos;
      priced += group.count;
      const key = group.category;
      sections.set(key, (sections.get(key) || 0) + price.chaos);
    }
  }

  return { chaos, priced, provisional, unknown, sections, units };
}

// ----------------------------------------------------------------- the panel

/** Cached panel nodes, so a price landing does not rebuild the whole thing. */
let els = null;

function markMarkup(size, variant = '') {
  return `<i class="pnc-mark${variant}" style="--pnc-mark:${size}px"></i>`;
}

function ensurePanel() {
  let panel = document.getElementById(PANEL_ID);
  // Re-anchor at the end of the body every time. The panel already sits at the
  // highest z-index there is, but so do the ad iframes, and when two elements
  // tie the one later in the document wins. Ads are injected while the page
  // runs, so whatever we appended at load time ends up underneath the next one.
  if (panel) {
    document.body.appendChild(panel);
    const button = document.getElementById(FAB_ID);
    if (button) document.body.appendChild(button);
    return panel;
  }

  panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.innerHTML = `
    <div class="pnc-head">
      ${markMarkup(11)}
      <div class="pnc-brand">Build cost</div>
      <div class="pnc-spacer"></div>
      <div class="pnc-head-meta"></div>
    </div>
    <div class="pnc-banners"></div>
    <div class="pnc-progress-slot"></div>
    <div class="pnc-total-slot"></div>
    <div class="pnc-list pnc-scroll"></div>
    <div class="pnc-foot"></div>
  `;
  document.body.appendChild(panel);

  els = {
    panel,
    mark: panel.querySelector('.pnc-mark'),
    meta: panel.querySelector('.pnc-head-meta'),
    banners: panel.querySelector('.pnc-banners'),
    progress: panel.querySelector('.pnc-progress-slot'),
    total: panel.querySelector('.pnc-total-slot'),
    list: panel.querySelector('.pnc-list'),
    foot: panel.querySelector('.pnc-foot'),
  };

  // Delegated and attached once. Rows are rebuilt as prices land, and a
  // listener per row would pile up dozens of them and open a tab per copy.
  els.list.addEventListener('click', (ev) => {
    if (ev.target.closest('.pnc-info') || ev.target.closest('.pnc-tip')) return;
    const row = ev.target.closest('.pnc-row--link');
    if (!row?.dataset.url) return;
    ev.preventDefault();
    // Straight from the click, with no await in between, or Chrome blocks it.
    window.open(row.dataset.url, '_blank', 'noopener');
  });

  return panel;
}

/** The whole panel, from `state`. Cheap enough to call after every item. */
function render() {
  if (!document.getElementById(PANEL_ID)) return;
  renderHead();
  renderBanners();
  renderProgress();
  renderTotal();
  renderFooter();
  renderFab();
}

function renderHead() {
  els.mark.className = `pnc-mark${
    state.phase === 'error' ? ' pnc-mark--error'
      : state.phase === 'paused' || state.phase === 'stopped' ? ' pnc-mark--idle'
        : ''
  }`;

  // The same count and the same item name as the status line below it, always.
  if (state.phase === 'trading' && state.queue.length) {
    const name = state.current ? displayName(state.current) : '';
    els.meta.textContent = `${state.done}/${state.queue.length}${name ? ` · ${name}` : ''}`;
  } else {
    els.meta.textContent = '';
  }
}

function renderBanners() {
  const blocks = [];

  // The one warning worth putting at the top, because it doubles a four-minute
  // wait — and the fix is one click away.
  if (state.notSignedIn && state.phase !== 'done') {
    blocks.push(`
      <div class="pnc-banner">
        <div class="pnc-banner-icon">!</div>
        <div class="pnc-banner-body">
          Not signed in to pathofexile.com — your rate limit is halved, so this pass takes
          about twice as long.
          <a class="pnc-signin" href="https://www.pathofexile.com/login" target="_blank"
             rel="noopener">Sign in, then re-run ↗</a>
        </div>
      </div>`);
  }

  const blockedFor = Math.ceil((state.blockedUntil - Date.now()) / 1000);
  if (blockedFor > 0) {
    blocks.push(`
      <div class="pnc-banner">
        <div class="pnc-banner-icon">!</div>
        <div class="pnc-banner-body">
          GGG is rate-limiting hard. Waiting it out — <b>resuming in ${blockedFor} s</b>, on its
          own. This build will take longer than the usual 2–6 min.
          <div class="pnc-banner-actions">
            <button class="pnc-btn pnc-btn--wide pnc-stop" type="button">Stop and keep
              poe.ninja prices</button>
          </div>
        </div>
      </div>`);
  }

  if (state.error) {
    blocks.push(`
      <div class="pnc-banner pnc-banner--error">
        <div class="pnc-banner-icon">!</div>
        <div class="pnc-banner-body">
          Trade is not answering. ${escapeHtml(state.error)}
          <div class="pnc-banner-actions">
            <button class="pnc-btn pnc-btn--wide pnc-btn--danger pnc-retry" type="button">Try
              again</button>
            <a class="pnc-link--muted pnc-bug" href="${PNC_BUG_URL}" target="_blank"
               rel="noopener">Report a bug</a>
          </div>
        </div>
      </div>`);
  }

  els.banners.innerHTML = blocks.join('');
  els.banners.querySelector('.pnc-stop')?.addEventListener('click', stopPass);
  // Trade falling over is the report we most want the diagnostics with.
  els.banners.querySelector('.pnc-bug')?.addEventListener('click', reportBug);
  els.banners.querySelector('.pnc-retry')?.addEventListener('click', () => {
    state.error = null;
    render();
    retryPass();
  });
}

function renderProgress() {
  const slot = els.progress;

  if (state.phase === 'reading') {
    slot.innerHTML = '';
    return;
  }

  if (state.phase === 'done' || state.phase === 'stopped') {
    const wall = formatDuration((state.finishedAt || Date.now()) - state.startedAt);
    const label = state.phase === 'done'
      ? `Done in ${wall} · ${state.queue.length} items · ${state.searches} searches`
        // Why a second look at the same build costs nothing, said where the
        // time it saved is on screen.
        + (state.fromCache ? ` · ${state.fromCache} from cache` : '')
      : `Stopped after ${state.done} of ${state.queue.length}. Kept what had arrived.`;
    // No "Details" link. It downloaded pncReport()'s JSON — request counts, per
    // item timings, which modifiers reached each query — which is a thing we
    // read and nobody else does. The one moment it is worth a stranger's time is
    // when they are reporting a bug, so that is where it went.
    slot.innerHTML = `
      <div class="pnc-done">
        <div class="pnc-dot pnc-dot--done"></div>
        <div class="pnc-what">${escapeHtml(label)}</div>
      </div>`;
    return;
  }

  if (!state.queue.length) {
    slot.innerHTML = '';
    return;
  }

  const total = state.queue.length;
  const donePct = Math.round((state.done / total) * 100);
  const paused = state.phase === 'paused';
  const eta = formatEta(etaSeconds());
  const name = state.current ? displayName(state.current) : '';
  const waiting = state.waitedSeconds >= 3
    ? ` · waiting <i>${state.waitedSeconds} s</i> for GGG's rate limit`
    : '';

  slot.innerHTML = `
    <div class="pnc-progress">
      <div class="pnc-progress-head">
        <div class="pnc-progress-label">${paused ? 'Paused' : 'Pricing on trade'}</div>
        <div class="pnc-spacer"></div>
        <div class="pnc-progress-count">${state.done}<i>/${total}</i></div>
        <div class="pnc-progress-eta">${paused ? '' : escapeHtml(eta)}</div>
      </div>
      <div class="pnc-bar">
        <div class="pnc-bar-done" style="width:${donePct}%"></div>
        ${paused ? '' : '<div class="pnc-bar-live"></div>'}
      </div>
      <div class="pnc-progress-status">
        <div class="pnc-dot${paused ? ' pnc-dot--idle' : ' pnc-dot--live'}"></div>
        <div class="pnc-what">${
          paused
            ? 'Holding the queue. Nothing is being asked of GGG.'
            : `<b>${escapeHtml(name)}</b>${waiting}`
        }</div>
        <div class="pnc-progress-buttons">
          <button class="pnc-btn pnc-pause" type="button">${paused ? 'Resume' : 'Pause'}</button>
          <button class="pnc-btn pnc-btn--stop pnc-stop" type="button">Stop</button>
        </div>
      </div>
    </div>`;

  slot.querySelector('.pnc-pause').addEventListener('click', togglePause);
  slot.querySelector('.pnc-stop').addEventListener('click', stopPass);
}

function renderTotal() {
  if (state.phase === 'reading') {
    els.total.innerHTML = '';
    return;
  }

  const totals = totalsOf();
  const cpd = state.chaosPerDivine;
  const asDivine = cpd && totals.chaos >= cpd;
  const value = asDivine ? (totals.chaos / cpd).toFixed(1) : Math.round(totals.chaos);
  const unit = asDivine ? 'div' : 'chaos';
  const aside = asDivine && totals.chaos >= 1000
    ? `≈ ${Math.round(totals.chaos / 1000)}k chaos`
    : cpd ? `1 div ≈ ${Math.round(cpd)} c` : '';

  const cover = `${totals.priced} of ${totals.units} items priced`
    + (totals.provisional ? ` · ${totals.provisional} still provisional` : '');

  els.total.innerHTML = `
    <div class="pnc-total">
      <div class="pnc-total-label">Minimum build cost</div>
      <div class="pnc-total-figure">
        <div class="pnc-total-value">${value}</div>
        <div class="pnc-total-unit">${unit}</div>
        <div class="pnc-spacer"></div>
        <div class="pnc-total-chaos">${escapeHtml(aside)}</div>
      </div>
      <div class="pnc-total-cover">${escapeHtml(cover)}</div>
    </div>
    ${swapSetOption()}`;

  els.total.querySelector('.pnc-opt-swap')?.addEventListener('change', toggleSwapSet);
}

/**
 * The one control that lives in the panel, and the reason the rule against it
 * does not apply: it is not a copy of anything.
 *
 * Everything in the popup and the options page applies to every build, so a
 * second copy in the panel would be a second thing to keep in step. This asks
 * about *this* character — does its swap set hold gear or spare gems — and it
 * has no twin anywhere. It is also only drawn when the answer could differ,
 * i.e. when the build has a swap set at all.
 */
function swapSetOption() {
  const swap = state.matches.filter(isSwapSet);
  if (!swap.length || state.phase === 'reading') return '';

  const on = state.includeSwapSet;
  const what = swap.length === 1 ? '1 item' : `${swap.length} items`;
  return `
    <label class="pnc-opt">
      <input class="pnc-opt-swap" type="checkbox" ${on ? 'checked' : ''}>
      <span class="pnc-opt-text">Count the swap weapon set<span class="pnc-opt-note"
        > · ${what}, usually storage</span></span>
    </label>`;
}

/**
 * Switching it on has to go and price two items nobody asked about yet, so it
 * costs searches; switching it off only takes them back out of a sum we already
 * have. Hence the asymmetry — one re-runs the pass, the other just redraws.
 */
function toggleSwapSet(ev) {
  state.includeSwapSet = !!ev.target.checked;

  state.groups = buildGroups(state.matches);
  paintBadges();
  buildList();
  render();

  if (!state.includeSwapSet || !lastRun || state.phase !== 'done') return;
  // Everything already priced comes back from the two-hour cache without a
  // request, so this spends searches on the newly included items and nothing
  // else.
  tradePass({ league: lastRun.league, index: lastRun.index, token: runToken })
    .catch(() => {});
}

function saleModeLabel() {
  return PNC_SALE_MODES.find((m) => m.id === settings.saleMode)?.label || settings.saleMode;
}

// ------ the item list
//
// Built once and updated in place. Rebuilding it after every item would reset
// the scroll position and close the tooltip the user was reading, and the pass
// finishes an item every few seconds for minutes.

function buildList() {
  els.list.innerHTML = '';
  const bySection = new Map();
  for (const group of state.groups) {
    if (!bySection.has(group.category)) bySection.set(group.category, []);
    bySection.get(group.category).push(group);
  }

  const sections = [...bySection.entries()]
    .sort((a, b) => SECTION_ORDER.indexOf(a[0]) - SECTION_ORDER.indexOf(b[0]));

  for (const [name, groups] of sections) {
    const head = document.createElement('div');
    head.className = 'pnc-sec';
    head.innerHTML = `
      <div class="pnc-sec-name"></div>
      <div class="pnc-sec-count"></div>
      <div class="pnc-sec-rule"></div>
      <div class="pnc-sec-total"></div>`;
    head.querySelector('.pnc-sec-name').textContent = name;
    head.querySelector('.pnc-sec-count').textContent = String(
      groups.reduce((sum, g) => sum + g.count, 0),
    );
    els.list.appendChild(head);

    groups.sort(byValue);
    for (const group of groups) {
      group.row = buildRow(group);
      els.list.appendChild(group.row);
    }
    bySection.set(name, { groups, head });
  }
  state.sections = bySection;
  updateList();
}

const byValue = (a, b) => (groupPrice(b).chaos || 0) - (groupPrice(a).chaos || 0);

/**
 * poe.ninja's item art, when the element is drawn with it as a background.
 *
 * Equipment and flasks have no `<img>` at all: the tile is a `<div>` sized to
 * the item's grid footprint with the art as a `background-image`, which is why
 * looking for images found nothing and every one of those rows came out blank.
 * The computed value can carry several layers, so we take the first that comes
 * from poecdn rather than assuming there is only one.
 */
function backgroundArt(el) {
  const bg = el.nodeType === 1 ? getComputedStyle(el).backgroundImage : '';
  if (!bg || !bg.includes('poecdn')) return null;
  for (const m of bg.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
    if (m[1].includes('poecdn')) return m[1];
  }
  return null;
}

/**
 * The item's own icon, straight off the page — no remote fetch, no CSP.
 *
 * The anchor is whatever `hostElement()` picked for the React component holding
 * the item, and on a character page that is a 47×20 label, not the tile. So we
 * climb. Measured on a live page, the three kinds of item sit differently:
 *
 *   equipment, flasks  the tile two levels up, art as a CSS background
 *   gems               one `<img>` in the anchor itself
 *   passive jewels     nothing — poe.ninja draws them as text on the tree
 *
 * Hence the two rules. **Background art wins wherever it is found**, because an
 * equipment tile also contains the `<img>` of every gem socketed into it — read
 * images first and Blunderbore wears the icon of the gem in its first socket.
 * **An `<img>` only counts when it is the only one in that subtree**, which is
 * what keeps the walk from reaching a container of several items and picking a
 * neighbour's art.
 *
 * `basicint` and `basicdex` looked like a shared decoration and were excluded
 * for a while, which blanked every jewel in the panel. They are not: a Cobalt
 * Jewel *is* drawn as `basicint` and a Viridian as `basicdex`. Two jewels of the
 * same base looking identical is the game, not a bug.
 */
function iconSrcFor(group) {
  for (const member of group.members) {
    const el = member.el;
    if (!el) continue;
    if (el.tagName === 'IMG' && el.src) return el.src;
    for (let node = el, i = 0; node && i < 4; node = node.parentElement, i++) {
      const background = backgroundArt(node);
      if (background) return background;
      const art = node.querySelectorAll?.('img[src*="poecdn"]');
      if (art?.length === 1) return art[0].src;
    }
  }
  return null;
}

function buildRow(group) {
  const row = document.createElement('div');
  row.className = 'pnc-row';

  const src = iconSrcFor(group);
  const icon = src
    ? Object.assign(document.createElement('img'), { className: 'pnc-icon', src, alt: '' })
    : Object.assign(document.createElement('div'), {
      className: 'pnc-icon pnc-icon--blank',
      innerHTML: markMarkup(9, ' pnc-mark--idle'),
    });
  row.appendChild(icon);

  const main = document.createElement('div');
  main.className = 'pnc-row-main';
  main.innerHTML = `
    <div class="pnc-row-name"><span class="pnc-row-title"></span></div>
    <div class="pnc-micro"></div>`;
  main.querySelector('.pnc-row-title').textContent = group.name;
  if (group.count > 1) {
    const chip = document.createElement('span');
    chip.className = 'pnc-count';
    chip.textContent = `×${group.count}`;
    main.querySelector('.pnc-row-name').appendChild(chip);
  }
  row.appendChild(main);

  const chip = document.createElement('div');
  chip.className = 'pnc-chip';
  row.appendChild(chip);

  const info = document.createElement('button');
  info.className = 'pnc-info';
  info.type = 'button';
  info.textContent = 'i';
  // On hover *and* on click: hover for the mouse, click for touch and for
  // anyone who reached it with the keyboard. It must never navigate — the row
  // under it is a link to the trade search.
  info.addEventListener('mouseenter', () => openTip(group));
  info.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (state.openTip === group.key) closeTip();
    else openTip(group);
  });
  row.appendChild(info);

  row.addEventListener('mouseenter', () => setHover(group, true));
  row.addEventListener('mouseleave', () => {
    setHover(group, false);
    if (state.openTip === group.key) closeTip();
  });

  group.nodes = { icon, main, chip, info, micro: main.querySelector('.pnc-micro') };
  return row;
}

function updateList() {
  if (!state.sections) return;

  for (const group of state.groups) {
    const price = groupPrice(group);
    const head = group.members[0];
    const { chip, info, micro } = group.nodes;

    group.row.classList.toggle('pnc-row--pending', price.pending);
    micro.textContent = `${group.slot} · ${microFact(head, group)}`;

    chip.className = 'pnc-chip';
    chip.textContent = '';
    if (price.pricing) {
      chip.className = 'pnc-skeleton';
    } else if (price.kind === 'unknown') {
      chip.classList.add(price.pending ? 'pnc-chip--pending' : 'pnc-chip--unknown');
      chip.textContent = '?';
    } else {
      chip.classList.add(
        price.pending ? 'pnc-chip--pending' : price.kind === 'floor' ? 'pnc-chip--floor' : 'pnc-chip--firm',
      );
      chip.textContent = (price.symbol ? `${price.symbol} ` : '')
        + formatChaos(price.chaos, state.chaosPerDivine);
    }

    // Hidden while provisional: there is no reason to show yet, and an (i) that
    // opens onto "still pricing" is a promise of information it does not have.
    info.className = 'pnc-info';
    if (price.pending) info.classList.add('pnc-info--hidden');
    // Amber when the number is a floor or a guess, so the eye finds the rows
    // actually worth reading.
    else if (price.kind !== 'firm') info.classList.add('pnc-info--flag');

    const url = head.appraisal?.url || head.searchUrl;
    if (url && !price.pending) {
      group.row.classList.add('pnc-row--link');
      group.row.dataset.url = url;
      group.row.title = 'Open this search on trade';
    } else {
      group.row.classList.remove('pnc-row--link');
      delete group.row.dataset.url;
      group.row.removeAttribute('title');
    }
  }

  for (const [, section] of state.sections) {
    if (!section.head) continue;
    const sum = section.groups.reduce(
      (total, g) => total + (groupPrice(g).kind === 'unknown' ? 0 : groupPrice(g).chaos), 0,
    );
    section.head.querySelector('.pnc-sec-total').textContent = sum
      ? formatChaos(sum, state.chaosPerDivine)
      : '—';
  }
}

/** Re-sorts by value. Only ever called when the pass finishes. */
function resortList() {
  if (!state.sections) return;
  for (const [, section] of state.sections) {
    section.groups.sort(byValue);
    for (const group of section.groups) els.list.appendChild(group.row);
  }
  // Sections keep their page order, so each header has to be put back in front
  // of its own rows after the rows were moved to the end.
  const ordered = [...state.sections.entries()]
    .sort((a, b) => SECTION_ORDER.indexOf(a[0]) - SECTION_ORDER.indexOf(b[0]));
  for (const [, section] of ordered) {
    els.list.appendChild(section.head);
    for (const group of section.groups) els.list.appendChild(group.row);
  }
}

// ------ the (i) tooltip

function closeTip() {
  els?.list.querySelector('.pnc-tip')?.remove();
  const open = state.groups.find((g) => g.key === state.openTip);
  open?.row?.classList.remove('pnc-row--open');
  state.openTip = null;
}

/** Shortened for a 10px chip: the full text is in the body above it. */
function modChip(text) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length > 30 ? `${clean.slice(0, 29)}…` : clean;
}

function openTip(group) {
  if (state.openTip === group.key) return;
  closeTip();

  const head = group.members[0];
  if (isPending(head)) return;
  state.openTip = group.key;
  group.row.classList.add('pnc-row--open');

  const a = head.appraisal;
  const mods = a?.modTexts || [];
  const shown = mods.slice(0, 3);
  const searches = a?.spend
    ? a.spend.wide.searches + a.spend.fallback.searches + a.spend.broad.searches
    : null;

  const meta = [
    a?.reliability ? `${a.reliability} confidence` : null,
    searches ? `${searches} search${searches === 1 ? '' : 'es'}` : null,
    head.elapsedMs ? formatDuration(head.elapsedMs) : null,
  ].filter(Boolean);

  const url = a?.url || head.searchUrl;
  const tip = document.createElement('div');
  tip.className = 'pnc-tip';
  tip.innerHTML = `
    <div class="pnc-tip-head"></div>
    <div class="pnc-tip-body"></div>
    ${shown.length ? `<div class="pnc-tip-mods">${
      shown.map((m) => `<span class="pnc-tip-mod">${escapeHtml(modChip(m))}</span>`).join('')
    }${
      mods.length > shown.length
        ? `<span class="pnc-tip-mod">+${mods.length - shown.length} more</span>`
        : ''
    }</div>` : ''}
    ${meta.length ? `<div class="pnc-tip-meta">${
      meta.map((m) => `<span>${escapeHtml(m)}</span>`).join('')
    }</div>` : ''}
    ${url ? '<div class="pnc-tip-link"><a target="_blank" rel="noopener">Open this search on trade ↗</a></div>' : ''}`;

  tip.querySelector('.pnc-tip-head').textContent = headlineFor(head);
  tip.querySelector('.pnc-tip-body').textContent = reasonFor(head);
  if (url) tip.querySelector('.pnc-tip-link a').href = url;
  tip.addEventListener('click', (ev) => ev.stopPropagation());

  group.row.appendChild(tip);
  // About 191px tall, and near the bottom of a scrolled list there is nowhere
  // below to put it. Flip rather than let it hang off the panel.
  const room = els.list.getBoundingClientRect().bottom - group.row.getBoundingClientRect().bottom;
  if (room < tip.offsetHeight) tip.classList.add('pnc-tip--above');
}

// ------ footer

// The badges are the only place the short units appear, and this is the only
// place anything about the badges is explained, so they belong here too.
const LEGEND = [
  ['≈', 'pnc-chip--firm', 'Priced on every mod it has'],
  ['≥', 'pnc-chip--floor', 'Worth at least this — counts as a minimum'],
  ['±', 'pnc-chip--floor', 'Several variants published, unsure which'],
  ['?', 'pnc-chip--unknown', 'No usable number — out of the total'],
  ['··', 'pnc-chip--pending', 'Still pricing — provisional'],
  ['d', 'pnc-chip--firm', 'Divine orbs · c is chaos — every price converts to one of the two'],
];

function renderFooter() {
  const totals = totalsOf();
  const notes = [];

  if (totals.unknown) {
    const gems = state.groups
      .filter((g) => g.category === 'Gems' && groupPrice(g).kind === 'unknown')
      .reduce((sum, g) => sum + g.count, 0);
    const rest = totals.unknown - gems;
    notes.push(
      `${totals.unknown} item(s) are not in the total`
      + (gems ? `: ${gems} gem(s) with no published price` : '')
      + (gems && rest ? `, ${rest} with no comparable listing` : rest && !gems ? `: ${rest} with no comparable listing` : '')
      + '.',
    );
  }
  notes.push(
    'This is a <strong>minimum</strong>: only what poe.ninja publishes and what trade could '
    + 'match is valued, and every ≥ below is a floor rather than a price.',
  );
  if (state.failed?.length) {
    notes.push(`Failed to load: ${escapeHtml(state.failed.map((f) => f.type).join(', '))}.`);
  }

  // Moved down here off the total. It reads as configuration, and configuration
  // that applies to every build belongs in the popup and the options page — but
  // the 80% is also the sentence that makes the number mean "one like this costs
  // X" rather than "this is worth X", so it stays visible as a fact with no
  // control attached.
  const settingsLine = state.phase === 'done'
    ? `<div class="pnc-settings-line">Priced at <b>${settings.minRollPercent}%</b> roll,
        ${escapeHtml(saleModeLabel())}. Cached for 2 h — reopening this build costs nothing.</div>`
    : '';

  els.foot.innerHTML = `
    <div class="pnc-notes">${notes.join(' ')}</div>
    ${settingsLine}
    <div class="pnc-legend">
      <button class="pnc-legend-toggle" type="button">
        <span class="pnc-legend-caret">${state.legendOpen ? '▾' : '▸'}</span>
        <span>What do the symbols mean?</span>
      </button>
      ${state.legendOpen ? `<div class="pnc-legend-list">${
        LEGEND.map(([sym, cls, text]) => `
          <div class="pnc-legend-row">
            <span class="pnc-chip ${cls} pnc-legend-sym">${sym}</span>
            <span class="pnc-legend-text">${text}</span>
          </div>`).join('')
      }</div>` : ''}
    </div>
    <div class="pnc-links">
      <a class="pnc-settings" href="#">Settings</a>
      <a class="pnc-link--muted pnc-clear" href="#"
         title="Stops the pass, removes the prices from the page and puts the button back">Clear prices</a>
      <div class="pnc-spacer"></div>
      <a class="pnc-link--muted pnc-bug" href="${PNC_BUG_URL}" target="_blank" rel="noopener">Report a bug</a>
      <a class="pnc-donate" href="${PNC_DONATE_URL}" target="_blank" rel="noopener">Buy me a Scroll</a>
    </div>`;

  els.foot.querySelector('.pnc-legend-toggle').addEventListener('click', () => {
    state.legendOpen = !state.legendOpen;
    renderFooter();
  });
  els.foot.querySelector('.pnc-settings').addEventListener('click', (ev) => {
    ev.preventDefault();
    // No settings controls in the panel itself: three copies of one control is
    // three things that can drift out of step.
    send('openOptions').catch(() => {});
  });
  // Where the ✕ used to be. It was in the header next to nothing else, one
  // glyph away from the floating button that merely folds the panel, and the
  // two read as the same gesture — so the one that threw four minutes of work
  // away was the easier of the two to press by accident.
  els.foot.querySelector('.pnc-clear').addEventListener('click', (ev) => {
    ev.preventDefault();
    closePanel();
  });
  els.foot.querySelector('.pnc-bug').addEventListener('click', reportBug);
}

// ------ edge states

function showLoading(text) {
  els.list.innerHTML = `<div class="pnc-loading"><div class="pnc-ring"></div><span></span></div>`;
  els.list.querySelector('span').textContent = text;
}

function showEmpty(title, text) {
  els.list.innerHTML = '<div class="pnc-empty"><strong></strong><span></span></div>';
  els.list.querySelector('strong').textContent = title;
  els.list.querySelector('span').textContent = text;
}

// ------------------------------------------------------------------- the FAB

/**
 * The trigger: a floating button rather than a panel that is always open.
 *
 * poe.ninja's own layout is busy enough; a 360px panel parked over it before
 * anyone asked for a price is rude. The button is the whole interface until
 * there is something to show.
 */
function ensureFab() {
  let fab = document.getElementById(FAB_ID);
  if (fab) return fab;

  fab = document.createElement('button');
  fab.id = FAB_ID;
  fab.type = 'button';
  fab.innerHTML = `${markMarkup(16)}<span class="pnc-fab-label">Price this build</span>`;
  fab.addEventListener('click', () => {
    if (state.collapsed) expandPanel();
    else if (document.getElementById(PANEL_ID)) collapsePanel();
    else run();
  });
  document.body.appendChild(fab);
  renderFab();
  return fab;
}

function renderFab() {
  const fab = document.getElementById(FAB_ID);
  if (!fab) return;

  const open = Boolean(document.getElementById(PANEL_ID));
  const running = state.phase === 'reading' || state.phase === 'trading';
  const totals = totalsOf();

  fab.classList.toggle('pnc-fab--active', open && !state.collapsed);
  fab.classList.toggle('pnc-fab--collapsed', state.collapsed);

  if (state.collapsed) {
    const amount = formatChaos(totals.chaos, state.chaosPerDivine);
    const meta = running && state.queue.length
      ? `${state.done}/${state.queue.length}${etaSeconds() ? ` · ${formatEta(etaSeconds()).replace(' left', '')}` : ''}`
      : '';
    fab.innerHTML = `
      ${running ? '<i class="pnc-spinner"></i>' : markMarkup(13)}
      <span class="pnc-fab-total${running ? ' pnc-fab-total--live' : ''}">${escapeHtml(amount)}</span>
      ${meta ? `<span class="pnc-fab-meta">${escapeHtml(meta)}</span>` : ''}`;
    fab.title = 'Show the breakdown';
    return;
  }

  fab.innerHTML = `
    ${running && open ? '<i class="pnc-fab-ring"></i>' : ''}
    ${markMarkup(16, open ? ' pnc-mark--hole' : '')}
    <span class="pnc-fab-label">${open ? 'Hide the panel' : 'Price this build'}</span>`;
  fab.title = open ? 'Fold the panel into the button' : "Price this build";
}

// -------------------------------------------------------------- panel actions

/**
 * Bumped whenever a run should stop. The trade pass checks it between items.
 *
 * Without it, closing the panel left `running` true until the pass finished on
 * its own — so the button did nothing for the next six minutes, and the pass
 * carried on spending GGG's budget filling in a panel that was no longer there.
 */
let runToken = 0;
let running = false;

/**
 * The "waiting N s" tickers, so cancelling can stop them.
 *
 * Checking the token inside each one is not enough: the item in flight when the
 * panel closed keeps its interval until its own request resolves, which is
 * minutes away. Reopening then starts a second ticker and the two write to the
 * same status line in turn — the counter flickering between 54 s and 11 s.
 */
const tickers = new Set();

function cancelRun() {
  runToken++;
  running = false;
  for (const id of tickers) clearInterval(id);
  tickers.clear();
  stopWatchingForDrawnItems();
}

/**
 * "Report a bug": says what the file is, then writes it and opens the tracker.
 *
 * A report that says "the ring price was wrong" cannot be acted on — the answer
 * is always in which modifiers reached the query and what trade sent back, and
 * that is exactly what `pncReport()` writes out. Asking for it in the issue
 * template gets it from about nobody; handing it over at the moment they click
 * gets it from most people. It is offered rather than attached silently,
 * because it is a file leaving their machine and they should know what is in it.
 */
function reportBug(ev) {
  ev.preventDefault();
  if (!els || els.panel.querySelector('.pnc-ask')) return;

  const ask = document.createElement('div');
  ask.className = 'pnc-ask';
  ask.innerHTML = `
    <div class="pnc-ask-head">Send the run's diagnostics with it?</div>
    <div class="pnc-ask-body">
      Saves a JSON file to your downloads and copies it to the clipboard, for you
      to attach to the report. It holds what this run did — the items on this
      public character page, the searches they turned into, what trade answered
      and how long each took. No account, no session, nothing about you.
    </div>
    <div class="pnc-ask-buttons">
      <button class="pnc-btn pnc-ask-no" type="button">Just open the tracker</button>
      <button class="pnc-btn pnc-btn--go pnc-ask-yes" type="button">Save it and open</button>
    </div>`;
  els.panel.appendChild(ask);

  const close = () => ask.remove();
  // Both paths open the tracker straight from the click. `pncReport()` awaits
  // the rate limiter, and a window.open() on the far side of that await is a
  // popup as far as Chrome is concerned — the same trap as the row links.
  ask.querySelector('.pnc-ask-no').addEventListener('click', () => {
    close();
    window.open(PNC_BUG_URL, '_blank', 'noopener');
  });
  ask.querySelector('.pnc-ask-yes').addEventListener('click', () => {
    close();
    window.open(PNC_BUG_URL, '_blank', 'noopener');
    window.pncReport().catch(() => {});
  });
}

/**
 * Folds the panel into the button, keeping the run and the badges alive.
 *
 * This is the state for reading the passive tree with the total in the corner
 * of the eye, and it is why the button carries the number: a four-minute pass
 * that has to be watched in a 360px panel is four minutes of nothing to do.
 */
function collapsePanel() {
  state.collapsed = true;
  closeTip();
  document.getElementById(PANEL_ID)?.remove();
  els = null;
  renderFab();
}

function expandPanel() {
  state.collapsed = false;
  ensurePanel();
  render();
  if (state.groups.length) buildList();
  else showLoading('Reading the character sheet…');
}

/** The ✕: ends the run and takes the badges with it. */
function closePanel() {
  cancelRun();
  clearBadges();
  closeTip();
  document.getElementById(PANEL_ID)?.remove();
  els = null;
  state.collapsed = false;
  resetState();
  publishStatus();
  renderFab();
}

function togglePause() {
  state.phase = state.phase === 'paused' ? 'trading' : 'paused';
  render();
  publishStatus();
}

/**
 * Ends the pass and keeps what has arrived. The items still in the queue keep
 * their provisional mark rather than losing poe.ninja's number.
 */
function stopPass() {
  if (state.phase !== 'trading' && state.phase !== 'paused') return;
  state.phase = 'stopped';
  state.current = null;
  state.finishedAt = Date.now();
  render();
  updateList();
  paintBadges();
  publishStatus();
}

function retryPass() {
  if (running) return;
  run();
}

// ---------------------------------------------------------------------- action

/** State of the last run, so the rare appraisal can reuse it. */
let lastRun = null;

// ------------------------------------------------- items the page hasn't drawn
//
// The swap set comes out of the harvest with no element, because poe.ninja only
// mounts it when you press "II" over the weapon. Press it and the tiles appear —
// so we watch for that, ask the bridge to mark the page again, and hand the
// matches the anchor they never had. Until then they live in the panel only.

let swapWatcher = null;
let reattaching = false;

async function reattachDrawnItems() {
  if (reattaching) return;
  // Costs nothing on the overwhelmingly common case: no orphans, no bridge call,
  // and the observer fires on every hover poe.ninja re-renders.
  const orphans = state.matches.filter((m) => !m.el && m.item?.id);
  if (!orphans.length) return;

  reattaching = true;
  try {
    const items = await askBridge();
    const anchorById = new Map(
      (items || []).filter((i) => i.id && i.anchor != null).map((i) => [i.id, i.anchor]),
    );
    let attached = 0;
    for (const match of orphans) {
      const anchor = anchorById.get(match.item.id);
      if (anchor == null) continue;
      const el = document.querySelector(`[data-pnc-item="${anchor}"]`);
      if (!el) continue;
      match.el = el;
      attached++;
    }
    if (attached) paintBadges();
  } catch {
    // The page changed under us or the bridge is gone. The panel is unaffected:
    // these items keep their prices, they just keep having nowhere to sit.
  } finally {
    reattaching = false;
  }
}

function watchForDrawnItems() {
  if (swapWatcher) return;
  const root = document.querySelector('article');
  if (!root) return;
  let timer = 0;
  swapWatcher = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(reattachDrawnItems, 400);
  });
  swapWatcher.observe(root, { childList: true, subtree: true });
}

function stopWatchingForDrawnItems() {
  swapWatcher?.disconnect();
  swapWatcher = null;
}

/**
 * Which rares are worth sending to trade.
 *
 * Cluster jewels used to be excluded on the grounds that they are worth the
 * notables they grant. They are — and each notable turns out to be an ordinary
 * modifier with its own stat id ("1 Added Passive Skill is Magnifier"), so they
 * can be searched like anything else.
 */
function isAppraisable(item) {
  return Boolean(item?.inventoryId);
}

/**
 * Whether poe.ninja's published price is for *this* copy or for the generic one.
 *
 * Only three kinds of unique differ from what poe.ninja priced, and only those
 * are worth a search — sending every unique would multiply the pass for nothing,
 * since for an ordinary one the published price is already the answer.
 */
function needsTradeLookup(match) {
  const item = match.item;
  if (!item) return false;

  if (isUnique(item)) {
    // No published price at all — either poe.ninja does not list it, or it
    // lists a different base under the same name. Trade searches name and base
    // together, so it can answer where the economy cannot.
    if (!match.price) return true;
    // poe.ninja publishes one price for every roll of these, and it is the
    // cheapest. `floor` is the same thing detected by counting.
    if (match.price?.floor || match.price?.rollPool?.length) return true;
    // Several published variants and no way to tell from the economy data which
    // one this is, so we show the best-selling one and mark it `±`. Ralakesh's
    // Impatience is the case: the copy that grants Power Charges is worth many
    // times the Frenzy or Endurance ones, and its modifiers are not flagged
    // optional, so nothing above catches it.
    if (match.price?.variantCount > 1) return true;
    // A Foulborn only when we could not pin its own published line. poe.ninja
    // prices each mutation separately once you account for links, so a matched
    // one already has its answer and a search would spend two requests to
    // arrive at the same number.
    if (isFoulborn(item) && !match.price?.variantMatched) return true;
    // Corrupted is not enough on its own — most corrupted uniques are worth what
    // the plain one is. It is the added implicit that moves the price.
    if (item.corrupted && hasAddedImplicit(match)) return true;
    return false;
  }

  return match.reason === 'random' && isAppraisable(item);
}

/** The published modifiers of the unique a Foulborn is a mutation of. */
function basePoolFor(match, index) {
  const item = match.item;
  if (!item || !isFoulborn(item)) return undefined;
  return plainEntryFor(item, index)?.modPool;
}

function plainEntryFor(item, index) {
  const plain = String(item.name || '').replace(/^Foulborn[ ]+/i, '');
  return index?.[normalizeName(plain)];
}

/**
 * This copy's mutations, in the same shape economy.js keys its lines by.
 *
 * Empty for anything that is not a Foulborn, which is what lets one comparison
 * serve both. When poe.ninja's page data names the mutations we use those; when
 * it does not — it carried them for Tulfall and not for Lori's Lantern — they
 * are whatever the item has that the plain unique is not published with,
 * because a Foulborn modifier *replaces* an original one.
 */
function mutationKeyOf(item, index) {
  if (!isFoulborn(item)) return '';

  const named = (item.mutatedMods || []).map(pncModTemplate);
  if (named.length) return named.sort().join('|');

  const base = new Set(plainEntryFor(item, index)?.modPool || []);
  if (!base.size) return '';
  return (item.explicitMods || [])
    .map(pncModTemplate)
    .filter((t) => !base.has(t))
    .sort()
    .join('|');
}

function isFoulborn(item) {
  return Boolean(item.mutated) || /^Foulborn\s/i.test(String(item.name || ''));
}

/**
 * "+1 to Maximum Power Charges" -> "+# to maximum power charges"
 *
 * Duplicated from `modTemplate` in src/lib/stats.js, which this classic script
 * cannot import. tools/check-wiring.mjs compares the two so they cannot drift.
 */
function pncModTemplate(text) {
  return String(text)
    .replace(/\(?-?\d+(?:\.\d+)?(?:\s*-\s*-?\d+(?:\.\d+)?)?\)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * An implicit poe.ninja does not publish for this unique, so a corruption put
 * it there.
 *
 * This started out counting implicits instead of comparing them, and the count
 * was wrong on the one item it most needed to get right: poe.ninja publishes one
 * implicit for Le Heup of All, its Iron Ring "Adds # to # Physical Damage to
 * Attacks", and a corrupted copy carries one implicit too — the corruption's.
 * One is not more than one, so the ring never went to trade at all and kept the
 * plain unique's price of about 7 c instead of the 9 div it is worth.
 */
function hasAddedImplicit(match) {
  const published = new Set((match.price?.implicitPool || []).map(pncModTemplate));
  return (match.item?.implicitMods || [])
    .some((mod) => !published.has(pncModTemplate(mod)));
}

// ------------------------------------------------------------------ debug log
//
// Every appraisal comes back saying what it cost — how many searches went to the
// wide query, how many to the fallback ladder, and how long was spent waiting on
// our own rate limiter versus waiting on GGG. The panel shows the summary of it
// in the (i) and in the "Done in…" line; `pncReport()` writes out the rest.

const runLog = [];

function logAppraisal(match, elapsedMs, error = null) {
  const a = match.appraisal || {};
  const item = match.item;
  const modCount = ['implicitMods', 'explicitMods', 'craftedMods', 'fracturedMods', 'enchantMods']
    .reduce((n, field) => n + (item[field] || []).length, 0);

  runLog.push({
    name: item.name || '(rare)',
    base: item.baseType,
    slot: item.inventoryId,
    corrupted: !!item.corrupted,
    mods: modCount,
    // How many modifiers poe.ninja flags `optional` for this unique. Zero means
    // we cannot tell a rolled modifier from a fixed one, which changes what the
    // search is allowed to assume — and is the difference between pricing a
    // Watcher's Eye at 16 div and at 2 c. See docs/poe-modifiers.md.
    rollPool: match.price?.rollPool?.length ?? 0,
    error: error ? String(error.message || error) : null,
    cached: !!a.cached,
    chaos: a.chaos ?? null,
    listings: a.total ?? null,
    strategy: a.strategy || (a.variant ? 'variant' : null),
    skipped: a.skipped || null,
    reliability: a.reliability ?? null,
    reliable: a.reliable ?? null,
    // Priced on fewer modifiers than the item carries, i.e. the badge shows ≥.
    partial: a.partial ?? null,
    filters: a.filters || [],
    spend: a.spend || null,
    // Wall clock as the page saw it, which includes the message round trip.
    elapsedMs,
  });
}

const PHASES = ['wide', 'fallback', 'broad'];

/**
 * Whether GGG rated this pass by IP alone, i.e. the caller was not signed in.
 *
 * Cautious on purpose: an empty or missing rule list means we never learned
 * anything, and guessing "not signed in" there would nag someone who is.
 */
function onlyIpRule(limits) {
  const rules = limits?.search?.rules;
  return Array.isArray(rules) && rules.length > 0
    && rules.every((r) => r.rule === 'ip');
}

function reportTotals() {
  const totals = { searches: 0, fetches: 0, waitingMs: 0, networkMs: 0 };
  for (const phase of PHASES) totals[phase] = { searches: 0, fetches: 0 };
  for (const entry of runLog) {
    // A cached answer carries the spend of the run that earned it. Counting it
    // again would invent requests that were never made.
    if (!entry.spend || entry.cached) continue;
    for (const phase of PHASES) {
      totals[phase].searches += entry.spend[phase].searches;
      totals[phase].fetches += entry.spend[phase].fetches;
      totals.searches += entry.spend[phase].searches;
      totals.fetches += entry.spend[phase].fetches;
    }
    totals.waitingMs += entry.spend.ms?.waiting || 0;
    totals.networkMs += entry.spend.ms?.network || 0;
  }
  return totals;
}

/**
 * Writes out what the last trade pass actually did, as a file and to the
 * console. Reachable from the panel's "Details" link and from the page console.
 *
 * The file is the point: it can be handed to someone who was not sitting here
 * watching the status line.
 */
window.pncReport = async function pncReport() {
  // Captured when the pass ended; see tradePass. Asking now would read a
  // service worker that has since been torn down and restarted.
  const limits = runLog.limits
    ?? { note: 'no pass has run in this tab yet' };
  const totals = reportTotals();
  const wallMs = (runLog.finishedAt || Date.now()) - (runLog.startedAt || Date.now());

  const report = {
    generatedAt: new Date().toISOString(),
    version: chrome.runtime.getManifest().version,
    url: location.href,
    league: runLog.league ?? null,
    settings,
    pass: {
      items: runLog.length,
      cached: runLog.filter((e) => e.cached).length,
      wallMs,
      // What the wall clock was spent on. Anything left over is ours: parsing,
      // rendering the panel, and the message round trip.
      waitingMs: totals.waitingMs,
      networkMs: totals.networkMs,
    },
    totals,
    limits,
    items: runLog,
  };

  console.log('[poe-ninja-build-cost] report', report);
  console.table(runLog.map((e) => ({
    item: `${e.name} ${e.base}`,
    wide: e.spend ? `${e.spend.wide.searches}s+${e.spend.wide.fetches}f` : '',
    fallback: e.spend ? `${e.spend.fallback.searches}s+${e.spend.fallback.fetches}f` : '',
    broad: e.spend ? `${e.spend.broad.searches}s+${e.spend.broad.fetches}f` : '',
    waiting: e.spend ? `${Math.round((e.spend.ms?.waiting || 0) / 100) / 10}s` : '',
    network: e.spend ? `${Math.round((e.spend.ms?.network || 0) / 100) / 10}s` : '',
    total: `${Math.round(e.elapsedMs / 100) / 10}s`,
    cached: e.cached || '',
  })));

  const text = JSON.stringify(report, null, 1);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  // Not `pnc-…`: check-wiring.mjs reads every `pnc-` string in here as a CSS
  // class that content.css owes it, and a filename is not one.
  link.download = `poe-ninja-build-cost-report-${stamp}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Late enough that the download has taken the blob, soon enough not to leak.
  setTimeout(() => URL.revokeObjectURL(url), 10000);

  try {
    await navigator.clipboard.writeText(text);
    console.log('[poe-ninja-build-cost] report copied to the clipboard and downloaded');
  } catch {
    // Needs the page focused; the download already happened either way.
    console.log('[poe-ninja-build-cost] report downloaded (clipboard needs the page focused)');
  }

  return report;
};

// ------------------------------------------------------------------ trade pass

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Holds here while the user has the pass paused. */
async function waitWhilePaused(token) {
  while (state.phase === 'paused' && token === runToken) await sleep(200);
}

/**
 * Prices the items that need a trade search, one at a time, updating the panel
 * after each so numbers appear as they arrive instead of after a minute of
 * nothing.
 *
 * Cached items come back instantly, so a second run on the same build — or a
 * page refresh — costs no requests at all.
 */
async function tradePass({ league, index, token }) {
  // Same order the panel lists them in — equipment, flasks, jewels, gems — so
  // watching the run makes sense against what you are reading.
  const pending = state.matches
    .filter((m) => !isExcluded(m) && needsTradeLookup(m))
    .sort((a, b) => SECTION_ORDER.indexOf(categoryOf(a)) - SECTION_ORDER.indexOf(categoryOf(b)));
  // Closed while the economy was loading, before a single trade request went
  // out. Nothing to mark and nothing to ask for.
  if (!pending.length || token !== runToken) {
    state.phase = 'done';
    state.finishedAt = Date.now();
    render();
    publishStatus();
    return;
  }

  // Marked up front. Until its search comes back the badge is showing
  // poe.ninja's price for the plain unique, which for a corrupted Le Heup is
  // 7 c against 9 div — so it needs to be visibly provisional rather than
  // looking like a finished answer.
  for (const match of pending) match.queued = true;

  state.queue = pending;
  state.phase = 'trading';
  state.startedAt = Date.now();
  updateList();
  paintBadges();
  render();
  publishStatus();

  runLog.length = 0;
  runLog.startedAt = Date.now();
  runLog.league = league;

  for (const match of pending) {
    await waitWhilePaused(token);
    // The user closed the panel, or pressed Stop. Either way, stop asking GGG
    // for prices nobody is waiting for — the appraisals already done are cached
    // for two hours, so reopening picks them straight back up.
    if (token !== runToken || state.phase === 'stopped') return;

    state.current = match;
    state.waitedSeconds = 0;
    render();
    updateList();
    paintBadge(match);

    const askedAt = Date.now();
    // Most items take three seconds and one in five takes thirty, because the
    // slow one is whichever happened to arrive when GGG's bucket was full.
    // Nothing is wrong when that happens, but a status line frozen on a name
    // for half a minute says the opposite, so it counts instead.
    const ticking = setInterval(async () => {
      state.waitedSeconds = Math.round((Date.now() - askedAt) / 1000);
      // A long wait is normally our own limiter pacing itself, which needs no
      // explanation. A 429 is different: GGG has told us to stand down, and
      // that is worth a banner and a countdown rather than a frozen name.
      if (state.waitedSeconds >= 12 && state.waitedSeconds % 4 === 0) {
        const limits = await send('limits').catch(() => null);
        state.blockedUntil = limits?.search?.blockedUntil || 0;
      }
      renderHead();
      renderProgress();
      renderBanners();
      renderFab();
    }, 1000);
    tickers.add(ticking);

    try {
      match.appraisal = await send('appraise', {
        item: match.item,
        rollPool: match.price?.rollPool,
        implicitPool: match.price?.implicitPool,
        // The plain unique behind a Foulborn, so the mutation can be deduced by
        // subtraction when poe.ninja's page data does not name it.
        basePool: basePoolFor(match, index),
        league,
        chaosPerDivine: state.chaosPerDivine,
        minRollPercent: settings.minRollPercent,
        saleMode: settings.saleMode,
        matchCorruptedImplicits: settings.matchCorruptedImplicits,
      });
      // Cancelled while this one was in the air. Its answer belongs to a panel
      // that is gone, so painting a badge or rebuilding the summary now would
      // write stale numbers into whatever is on screen instead.
      if (token !== runToken) return;

      match.elapsedMs = Date.now() - askedAt;
      match.queued = false;
      if (match.appraisal.cached) state.fromCache++;
      state.elapsed.push(match.elapsedMs);
      state.searches += match.appraisal.spend
        ? PHASES.reduce((n, p) => n + match.appraisal.spend[p].searches, 0)
        : 0;
      logAppraisal(match, match.elapsedMs);

      state.done++;
      state.current = null;
      state.blockedUntil = 0;
      paintBadge(match);
      updateList();
      render();
      publishStatus();
    } catch (err) {
      if (token !== runToken) return;
      match.failed = true;
      match.queued = false;
      logAppraisal(match, Date.now() - askedAt, err);
      // poe.ninja's prices stay on screen and the queued items keep their
      // provisional mark: a total that is provisional is still a total, and
      // losing it because one request failed helps nobody.
      state.error = err.message;
      state.phase = 'stopped';
      state.current = null;
      state.finishedAt = Date.now();
      render();
      updateList();
      paintBadges();
      publishStatus();
      return;
    } finally {
      // Including on the way out of both returns, or the timer would keep
      // rewriting a status line that has already moved on.
      clearInterval(ticking);
      tickers.delete(ticking);
    }

    // Learnt from the first answer, not guessed: GGG only names the rules it
    // applied once it has answered something. Signed out the pass takes about
    // twice as long, and nothing else on screen would explain why.
    if (state.done === 1) {
      const limits = await send('limits').catch(() => null);
      state.notSignedIn = onlyIpRule(limits);
      renderBanners();
    }
  }

  runLog.finishedAt = Date.now();
  // Read the limiter now, not when the report is asked for. The service worker
  // is torn down after about thirty seconds of quiet and comes back with virgin
  // buckets, so a report written a minute later showed `max: 1, spent: 0` — a
  // limiter that had never seen a response, which says nothing about the pass
  // that just ran.
  runLog.limits = await send('limits').catch((err) => ({ error: String(err.message) }));
  if (token !== runToken) return;

  state.phase = 'done';
  state.current = null;
  state.finishedAt = Date.now();
  // Only now: the user has been reading this list for minutes and moving a row
  // under their eyes mid-pass is worse than an order that is briefly stale.
  resortList();
  updateList();
  render();
  publishStatus();
}

async function run() {
  if (running) return;
  running = true;
  // Claimed for this run. Closing the panel bumps it, and everything below
  // that takes time checks whether it is still the current one.
  const token = ++runToken;

  clearBadges();
  resetState();
  state.phase = 'reading';
  state.collapsed = false;
  ensurePanel();
  render();
  showLoading('Reading the character sheet…');
  publishStatus();

  settings = await pncLoadSettings();

  try {
    const { index, icons, chaosPerDivine, failed, league } = await send('prices', {
      leagueSlug: leagueSlugFromUrl(),
    });
    if (token !== runToken) return;

    state.chaosPerDivine = chaosPerDivine;
    state.failed = failed;
    state.league = league;

    // Primary path: the real JSON the page holds in memory. If the bridge fails
    // (poe.ninja changed its internals) we fall back to scanning the DOM.
    const items = await askBridge();
    if (token !== runToken) return;

    const usingBridge = Boolean(items?.length);
    const matches = usingBridge ? scanFromBridge(items, index) : scanItems(index, icons);
    state.source = usingBridge ? 'page data' : 'text and icons (fallback)';

    if (!matches.length) {
      state.phase = 'error';
      render();
      showEmpty(
        'Nothing to price here',
        'This character has no equipment on poe.ninja. Open a character with a visible gear '
        + 'grid, or run pncDiagnose() in the console if you think there is one.',
      );
      return;
    }

    state.matches = matches;
    state.groups = buildGroups(matches);
    state.phase = 'ninja';

    paintBadges();
    buildList();
    render();
    watchForDrawnItems();
    // `index` rides along so switching the swap set on after the pass has
    // finished can price the two items it adds without reloading the economy.
    lastRun = { matches, chaosPerDivine, league, failed, index };

    // Every badge gets a trade link, including the ones priced from poe.ninja's
    // economy. The trade site accepts the query in the URL, so this costs no
    // requests at all — it just builds links.
    if (usingBridge) {
      try {
        const { urls } = await send('links', {
          items: matches.map((m) => m.item),
          league,
          minRollPercent: settings.minRollPercent,
          saleMode: settings.saleMode,
        });
        if (token !== runToken) return;
        for (const match of matches) {
          const url = urls[match.item?.index];
          if (!url) continue;
          // Kept on the match too, so the rows can link as well.
          match.searchUrl = url;
          if (match.badge) linkToSearch(match.badge, url);
        }
        updateList();
      } catch {
        // links are a nicety; never let them break the run
      }
    }

    // Straight on into the trade pass. Everything above is already on screen, so
    // the slow part runs behind numbers the user can already read.
    await tradePass({ league, index, token });
  } catch (err) {
    if (token !== runToken) return;
    state.phase = 'error';
    state.error = err.message;
    render();
    if (!state.groups.length) showEmpty('Could not price this build', err.message);
  } finally {
    // Only if this run is still the current one. If the panel was closed,
    // `cancelRun` has already released the flag and a newer run may hold it —
    // clearing it here would let two passes run at once.
    if (token === runToken) {
      running = false;
      renderFab();
    }
  }
}

/**
 * Calibration helper for when poe.ninja changes its markup: dumps the page's
 * short texts and icon filenames so we can see whether item names are actually
 * in the DOM and in what shape.
 */
window.pncDiagnose = function pncDiagnose() {
  const texts = new Set();
  for (const { text } of textCandidates(document.body)) texts.add(text);
  const icons = new Set();
  for (const img of document.querySelectorAll('img[src*="poecdn"]')) {
    const art = artFilename(img.getAttribute('src'));
    if (art) icons.add(art);
  }
  const output = { texts: [...texts], icons: [...icons], lastRun: Boolean(lastRun) };
  console.log('[poe-ninja-build-cost]', output);
  return output;
};

// Both names are also exposed on the page's own window by page-bridge.js, which
// forwards the call here — the console cannot see this realm. Keeping them on
// `window` too means they still work from the content script context that the
// DevTools context dropdown offers.
window.addEventListener('message', async (ev) => {
  if (ev.source !== window || ev.data?.source !== 'pnc-console-request') return;
  const { name, id } = ev.data;
  let result;
  try {
    result = name === 'report' ? await window.pncReport() : window.pncDiagnose();
  } catch (err) {
    result = { error: String(err?.message || err) };
  }
  // Plain data only: postMessage structured-clones, and anything else in here
  // would throw on the way out instead of arriving.
  window.postMessage({ source: 'pnc-console-reply', id, result }, '*');
});

// ------------------------------------------------------------------- lifecycle

/**
 * The button appears only once the gear grid is actually in the DOM.
 *
 * poe.ninja renders the character sheet client-side, so on a cold load there is
 * a second where the route is right and the page is empty. A button offered then
 * promises something it cannot do.
 */
function gearGridReady() {
  return Boolean(document.querySelector('article img[src*="poecdn"]'));
}

function sync() {
  if (isCharacterPage()) {
    if (gearGridReady()) ensureFab();
  } else {
    closePanel();
    document.getElementById(FAB_ID)?.remove();
  }
}

// poe.ninja is a SPA: the URL changes without a reload, so we react by hand.
//
// No patching of `history.pushState`: a content script lives in an isolated
// realm, so the patch would only affect our own copy and the page's calls would
// sail right past. Polling the URL is ugly but it actually works.
let lastUrl = location.href;
setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    // A different character: whatever is on screen belongs to the old one.
    closePanel();
  }
  sync();
}, 500);
window.addEventListener('popstate', sync);

sync();
