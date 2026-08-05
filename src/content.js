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
const BADGE_CLASS = 'pnc-badge';

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
  'Offhand', 'Ring', 'Ring2', 'Amulet', 'Belt',
]);

/**
 * Category for the summary breakdown.
 *
 * With the bridge, the equipment slot is enough. The fallback path has no item
 * data — only the name of the price line — so we guess from the base type and
 * anything that doesn't fit lands in "Other".
 */
/**
 * Section order in the summary, matching how poe.ninja lays the page out:
 * equipment first, then flasks under it, then the jewel blocks, then skills.
 *
 * Sorting by subtotal put the money first, which read well but meant the panel
 * shuffled itself between builds and never lined up with what was on screen.
 */
const SECTION_ORDER = ['Equipment', 'Flasks', 'Jewels', 'Gems', 'Other', 'Unpriced'];

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
    const exact = entry.uniq.find(([l, c]) => l === item.links && c === corrupted);
    const sameLinks = entry.uniq.filter(([l]) => l === item.links);
    const hit = exact || sameLinks[0];
    if (hit) {
      return {
        ...entry,
        chaos: hit[2],
        variantCount: 0,
        detail: item.links >= 5 ? `${item.links}L` : null,
      };
    }
  }

  return entry;
}

function scanFromBridge(items, index) {
  const found = [];
  for (const item of items) {
    if (item.anchor == null) continue;
    const el = document.querySelector(`[data-pnc-item="${item.anchor}"]`);
    if (!el) continue;

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

// -------------------------------------------------------------------- painting

function formatChaos(chaos, chaosPerDivine) {
  if (chaos == null) return '—';
  if (chaosPerDivine && chaos >= chaosPerDivine) {
    return `${(chaos / chaosPerDivine).toFixed(1)} div`;
  }
  return `${chaos < 10 ? chaos.toFixed(1) : Math.round(chaos)} c`;
}

/** Names come from poe.ninja but end up in innerHTML, so they get escaped. */
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function clearBadges() {
  document.querySelectorAll(`.${BADGE_CLASS}`).forEach((n) => n.remove());
}

/**
 * Container to pin a corner badge to: the icon cell.
 *
 * We walk up from the anchor looking for something icon-sized. If there isn't
 * one (a text list, say) we return null and the badge goes inline instead.
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
 * Places the badge. Equipment, jewels and flasks get it overlaid on the bottom
 * right corner of the icon, where it covers nothing. Gems are rendered as a
 * text list, so there it goes next to the name.
 */
function placeBadge(match, badge) {
  const corner = categoryOf(match) !== 'Gems' && iconContainer(match.el);
  if (!corner) {
    match.el.insertAdjacentElement('afterend', badge);
  } else {
    if (getComputedStyle(corner).position === 'static') corner.style.position = 'relative';
    badge.classList.add('pnc-badge--corner');
    // Corner space is tight and a build has a dozen priceless rares. Spelling
    // "no price" on every icon shouts louder than the actual prices and spills
    // out of small icons like cluster jewels, so those get a short mark and
    // keep the explanation in the tooltip.
    if (badge.dataset.short) badge.textContent = badge.dataset.short;
    corner.appendChild(badge);
  }
  // Keep the reference: corner badges are not siblings of the anchor, so the
  // rare appraisal could not find them again to update the price.
  match.badge = badge;
}

function paintBadges(matches, chaosPerDivine) {
  for (const match of matches) {
    const { price, item } = match;

    if (!price) {
      const label = item?.name || item?.typeLine || 'Item';
      const isUnpricedUnique = match.reason === 'unpriced';
      const badge = document.createElement('span');
      // An unpriced unique stays loud: it can be worth a lot and the user should
      // go look. A rare with random mods is expected, so it fades into a dash.
      badge.className = `${BADGE_CLASS} ${isUnpricedUnique ? 'pnc-badge--warn' : 'pnc-badge--noprice'}`;
      badge.textContent = isUnpricedUnique ? 'unpriced' : 'no price';
      badge.dataset.short = isUnpricedUnique ? '?' : '–';
      badge.title = isUnpricedUnique
        ? `${label}: poe.ninja publishes no price for this unique. It can be worth a lot.`
        : `${label}: random mods, so no market price for this exact item exists.`;
      placeBadge(match, badge);
      continue;
    }

    const uncertain = price.floor || price.variantCount > 1;
    const badge = document.createElement('span');
    badge.className = BADGE_CLASS;
    badge.textContent = (price.floor ? '≥ ' : '') + formatChaos(price.chaos, chaosPerDivine);

    if (price.floor) {
      badge.title =
        `${price.name}: the price depends on the item's roll. poe.ninja only ` +
        `publishes the cheapest one, so this is a floor, not its value.`;
    } else if (price.variantCount > 1) {
      const [min, max] = price.spread || [];
      badge.title =
        `${price.name}: ${price.variantCount} variants` +
        (min ? ` (${Math.round(min)}c – ${Math.round(max)}c depending on which)` : '') +
        `. Showing the best-selling one, which need not be this one.`;
    } else {
      badge.title = `${price.name} — ${price.listings} listings on poe.ninja`;
    }

    if (price.detail) badge.textContent += ` (${price.detail})`;
    if (uncertain) badge.classList.add('pnc-badge--warn');

    placeBadge(match, badge);
  }
}

// ----------------------------------------------------------------------- panel

function ensurePanel() {
  let panel = document.getElementById(PANEL_ID);
  if (panel) return panel;

  panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.innerHTML = `
    <div class="pnc-head">
      <strong>Build cost</strong>
      <button class="pnc-close" title="Close">×</button>
    </div>
    <div class="pnc-body">
      <button class="pnc-run">Calculate cost</button>
      <div class="pnc-status"></div>
      <div class="pnc-summary"></div>
    </div>
  `;
  document.body.appendChild(panel);

  panel.querySelector('.pnc-close').addEventListener('click', () => {
    clearBadges();
    panel.remove();
  });
  panel.querySelector('.pnc-run').addEventListener('click', run);

  return panel;
}

function setStatus(text, kind = '') {
  const node = document.querySelector(`#${PANEL_ID} .pnc-status`);
  if (node) {
    node.textContent = text;
    node.className = `pnc-status ${kind}`;
  }
}

/** Merges identical rows: nine identical Raise Spectre need one line, not nine. */
function mergeDuplicates(rows) {
  const merged = new Map();
  for (const row of rows) {
    const key = `${row.category}|${row.name}|${row.mark}|${row.chaos}`;
    const prev = merged.get(key);
    if (prev) {
      prev.count++;
      prev.chaos += row.chaos; // the row shows the group's total, not the unit
    } else {
      merged.set(key, { ...row, count: 1 });
    }
  }
  return [...merged.values()];
}

function renderSummary(matches, chaosPerDivine, failed) {
  const box = document.querySelector(`#${PANEL_ID} .pnc-summary`);
  if (!box) return;

  // Only appraisals we trust make it into the total.
  const usesAppraisal = (m) => Boolean(m.appraisal?.reliable && m.appraisal.chaos);
  const appraised = matches.filter(usesAppraisal);
  // A `≥` unique that trade did price has both an economy number and an
  // appraisal. The appraisal wins — it's the actual roll — and taking both would
  // count the item twice.
  const priced = matches.filter((m) => typeof m.price?.chaos === 'number' && !usesAppraisal(m));
  const random = matches.filter((m) => !m.price && m.reason !== 'unpriced');
  const unpriced = matches.filter((m) => m.reason === 'unpriced');
  const unreliable = matches.filter((m) => m.appraisal && !m.appraisal.reliable && m.appraisal.chaos);
  const uncertain = priced.filter((m) => m.price.floor || m.price.variantCount > 1);

  const total =
    priced.reduce((sum, m) => sum + m.price.chaos, 0) +
    appraised.reduce((sum, m) => sum + m.appraisal.chaos, 0);

  const rows = [
    ...priced.map((m) => ({
      name: m.price.name,
      chaos: m.price.chaos,
      mark: m.price.floor ? '≥' : m.price.variantCount > 1 ? '±' : '',
      category: categoryOf(m),
    })),
    ...appraised.map((m) => ({
      name: m.item?.name || m.price?.name || m.item?.baseType || 'Item',
      chaos: m.appraisal.chaos,
      mark: '≈',
      category: categoryOf(m),
    })),
  ];

  // Group and order by subtotal: put the money first.
  const groups = new Map();
  for (const row of mergeDuplicates(rows)) {
    if (!groups.has(row.category)) groups.set(row.category, []);
    groups.get(row.category).push(row);
  }
  const sections = [...groups.entries()]
    .map(([name, items]) => ({
      name,
      items: items.sort((a, b) => b.chaos - a.chaos),
      units: items.reduce((s, f) => s + f.count, 0),
      subtotal: items.reduce((s, f) => s + f.chaos, 0),
    }))
    .sort((a, b) => SECTION_ORDER.indexOf(a.name) - SECTION_ORDER.indexOf(b.name));

  // Uniques poe.ninja doesn't price get their own section at the end: shown
  // only as a footnote, they would look like something the extension ate.
  if (unpriced.length) {
    sections.push({
      name: 'Unpriced',
      units: unpriced.length,
      subtotal: null,
      items: unpriced.map((m) => ({
        name: m.item?.name || m.price?.name || 'Unique',
        chaos: null,
        mark: '',
        count: 1,
      })),
    });
  }

  const blocks = sections
    .map(
      (s) => `
      <div class="pnc-cat">
        <div class="pnc-cat-head">
          <span>${escapeHtml(s.name)} <em>(${s.units})</em></span>
          <strong>${s.subtotal === null ? '—' : formatChaos(s.subtotal, chaosPerDivine)}</strong>
        </div>
        <table class="pnc-table">${s.items
          .map(
            (f) => `
          <tr>
            <td>${escapeHtml(f.name)}${f.count > 1 ? ` <em class="pnc-x">×${f.count}</em>` : ''}</td>
            <td class="pnc-num">${f.mark ? `<span class="pnc-warn">${f.mark}</span> ` : ''}${
              f.chaos === null
                ? '<span class="pnc-warn">—</span>'
                : formatChaos(f.chaos, chaosPerDivine)
            }</td>
          </tr>`,
          )
          .join('')}</table>
      </div>`,
    )
    .join('');

  const note = (text, warn = false) =>
    `<div class="pnc-note${warn ? ' pnc-warn' : ''}">${text}</div>`;

  const pendingRares = random.length - appraised.length - unreliable.length;

  box.innerHTML = `
    <div class="pnc-total pnc-total--header">
      <span>Minimum (${rows.length} items)</span>
      <strong>${formatChaos(total, chaosPerDivine)}</strong>
    </div>
    ${blocks}
    ${chaosPerDivine ? note(`1 div ≈ ${Math.round(chaosPerDivine)} c`) : ''}
    ${
      uncertain.length
        ? note(
            `${uncertain.length} item(s) marked ≥ or ±: their price depends on the roll or the
             variant and can be far higher.`,
            true,
          )
        : ''
    }
    ${
      appraised.length
        ? note(
            `${appraised.length} rare(s) marked ≈ are the price of <em>similar</em> items on
             trade, not of these ones: a specific rare has no market price.`,
          )
        : ''
    }
    ${
      unreliable.length
        ? note(
            `${unreliable.length} rare(s) appraised but left out of the total: the search
             returned too many or too few similar items to trust.`,
            true,
          )
        : ''
    }
    ${
      pendingRares > 0
        ? note(`${pendingRares} rare/magic item(s) not appraised yet. Use the button above.`)
        : ''
    }
    ${
      unpriced.length
        ? note(
            `"Unpriced" are uniques poe.ninja doesn't publish, usually because their value
             depends on something the economy doesn't break down. They can be worth a lot and
             do not count towards the total.`,
            true,
          )
        : ''
    }
    ${note(
      `This is a <strong>minimum</strong>, not the real cost: only what poe.ninja publishes in
       its economy is valued (uniques, gems, cluster jewels…).`,
    )}
    ${failed?.length ? note(`Failed to load: ${failed.map((f) => f.type).join(', ')}`, true) : ''}
  `;
}

// ---------------------------------------------------------------------- action

let running = false;

/** State of the last run, so the rare appraisal can reuse it. */
let lastRun = null;

/**
 * Which rares are worth sending to trade.
 *
 * Jewels are excluded: a cluster jewel is worth whatever notables it grants,
 * and that isn't expressible with the mods we read, so we'd spend requests to
 * return an invented price.
 */
function isAppraisable(item) {
  // Cluster jewels used to be excluded on the grounds that they are worth the
  // notables they grant. They are — and each notable turns out to be an ordinary
  // modifier with its own stat id ("1 Added Passive Skill is Magnifier"), so
  // they can be searched like anything else.
  return Boolean(item?.inventoryId);
}

/**
 * Which items the trade pass should look up.
 *
 * Two different cases, both worth a request:
 *  - rares and magic gear, which have no market price at all;
 *  - uniques marked `≥`, whose poe.ninja number is the cheapest roll rather
 *    than a value. Those are searched by name plus their own mods, so a
 *    Watcher's Eye stops reading "40 c" when it rolled something expensive.
 *
 * Jewels are only included for that second case: a rare cluster jewel is worth
 * whatever notables it grants, which we can't express with the mods we read.
 */
function needsTradeLookup(match) {
  if (match.price?.floor && match.item && isUnique(match.item)) return true;
  return match.reason === 'random' && isAppraisable(match.item);
}

/**
 * Prices the items that need a trade search, one at a time, refreshing the
 * panel after each so numbers appear as they arrive instead of after a minute
 * of nothing.
 *
 * Cached items come back instantly, so a second run on the same build — or a
 * page refresh — costs no requests at all.
 */
async function tradePass(matches, { league, chaosPerDivine, failed }) {
  const pending = matches.filter((m) => needsTradeLookup(m));
  if (!pending.length) return;

  let done = 0;
  let live = 0; // the ones that actually hit the network

  for (const match of pending) {
    done++;
    const label = match.item.name || match.item.baseType;
    setStatus(`Pricing on trade… ${done}/${pending.length} — ${label}`);

    try {
      match.appraisal = await send('appraise', {
        item: match.item,
        rollPool: match.price?.rollPool,
        implicitPool: match.price?.implicitPool,
        league,
        chaosPerDivine,
        minRollPercent: settings.minRollPercent,
        saleMode: settings.saleMode,
        matchCorruptedImplicits: settings.matchCorruptedImplicits,
      });
      if (!match.appraisal.cached) live++;
      updateRareBadge(match, chaosPerDivine);
      renderSummary(matches, chaosPerDivine, failed);
    } catch (err) {
      setStatus(`Stopped after ${done - 1} of ${pending.length}: ${err.message}`, 'pnc-warn');
      return;
    }
  }

  const cached = pending.length - live;
  setStatus(
    `Done. ${pending.length} item(s) priced on trade` +
      (cached ? `, ${cached} from cache.` : '.'),
  );
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
  badge.title += ' Click to open this search on the trade site.';
  badge.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    // Straight from the click, with no await in between, or Chrome treats it as
    // a popup and blocks it.
    window.open(badge.dataset.searchUrl, '_blank', 'noopener');
  });
}

/** Swaps the "no price" badge for the estimate, or for why there isn't one. */
function updateRareBadge(match, chaosPerDivine) {
  const badge = match.badge;
  if (!badge) return;
  const a = match.appraisal;

  badge.classList.remove('pnc-badge--noprice');

  if (a.skipped || !a.chaos) {
    // A `≥` unique keeps poe.ninja's floor if trade turned up nothing: a floor
    // is still more informative than a question mark.
    if (match.price) {
      badge.title += ' — no listing with these mods found on trade.';
      return;
    }
    badge.textContent = '?';
    badge.classList.add('pnc-badge--warn');
    badge.title = a.skipped || 'The search returned no listings.';
    return;
  }

  // An unreliable number is worse than none. A rare helmet showing "1 c" reads
  // as a price, when all it means is that 158 helmets matched filters that
  // narrowed nothing down. The figure stays in the tooltip, not on the icon.
  if (!a.reliable) {
    badge.textContent = '?';
    badge.classList.add('pnc-badge--warn');
    badge.title =
      `${a.total} similar items matched — ${a.total > 120 ? 'far too many' : 'too few'} to ` +
      `estimate from. For reference the cheapest were around ` +
      `${formatChaos(a.chaos, chaosPerDivine)}, but that is not this item's price and is ` +
      `excluded from the total.`;
    return;
  }

  badge.textContent = `${a.partial ? '≥' : '≈'} ${formatChaos(a.chaos, chaosPerDivine)}`;
  badge.classList.remove('pnc-badge--warn');
  badge.classList.add('pnc-badge--similar');
  linkToSearch(badge, a.url);
  badge.title = a.variant
    ? `${a.total} listing(s) of this unique matching ${a.mods} of its ${a.rolled} rolled ` +
      `modifier(s), cheapest median. Replaces poe.ninja's floor price.` +
      (a.partial ? ' Priced on fewer mods than it has, so it is worth at least this.' : '')
    : `Median of the cheapest listings among ${a.total} similar items. ` +
      `Reliability: ${a.reliability}.` +
      (a.adjusted ? ' Filter count was adjusted to find a usable result.' : '');
}

async function run() {
  if (running) return;
  running = true;
  clearBadges();
  const runButton = document.querySelector(`#${PANEL_ID} .pnc-run`);
  if (runButton) {
    runButton.disabled = true;
    runButton.textContent = 'Working…';
  }
  settings = await pncLoadSettings();
  setStatus('Loading poe.ninja economy…');

  try {
    const { index, icons, chaosPerDivine, failed, league } = await send('prices', {
      leagueSlug: leagueSlugFromUrl(),
    });
    setStatus(`League: ${league}. Reading the page's items…`);

    // Primary path: the real JSON the page holds in memory. If the bridge fails
    // (poe.ninja changed its internals) we fall back to scanning the DOM.
    const items = await askBridge();
    const usingBridge = Boolean(items?.length);
    const matches = usingBridge ? scanFromBridge(items, index) : scanItems(index, icons);
    const source = usingBridge ? 'page data' : 'text and icons (fallback)';

    if (!matches.length) {
      setStatus('No items recognised. Open the console and run pncDiagnose().', 'pnc-warn');
      return;
    }

    paintBadges(matches, chaosPerDivine);
    renderSummary(matches, chaosPerDivine, failed);
    lastRun = { matches, chaosPerDivine, league, failed };

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
        for (const match of matches) {
          const url = urls[match.item?.index];
          if (url && match.badge) linkToSearch(match.badge, url);
        }
      } catch {
        // links are a nicety; never let them break the run
      }
    }

    // Not just rares any more: `≥` uniques go to trade too, to find out what
    // the roll they actually have is worth.
    const withPrice = matches.filter((m) => m.price).length;
    setStatus(`${withPrice} of ${matches.length} items priced — via ${source}.`);

    // Straight on into the trade pass. Everything above is already on screen, so
    // the slow part runs behind numbers the user can already read.
    await tradePass(matches, { league, chaosPerDivine, failed });
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'pnc-warn');
  } finally {
    running = false;
    const button = document.querySelector(`#${PANEL_ID} .pnc-run`);
    if (button) {
      button.disabled = false;
      button.textContent = 'Calculate cost';
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
  const output = { texts: [...texts], icons: [...icons] };
  console.log('[poe-ninja-build-cost]', output);
  return output;
};

// ------------------------------------------------------------------- lifecycle

function sync() {
  if (isCharacterPage()) {
    ensurePanel();
  } else {
    clearBadges();
    document.getElementById(PANEL_ID)?.remove();
  }
}

// poe.ninja is a SPA: the URL changes without a reload, so we react by hand.
//
// No patching of `history.pushState`: a content script lives in an isolated
// realm, so the patch would only affect our own copy and the page's calls would
// sail right past. Polling the URL is ugly but it actually works.
let lastUrl = location.href;
setInterval(() => {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  sync();
}, 500);
window.addEventListener('popstate', sync);

sync();
