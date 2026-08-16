// Path of Building paste pages (poe.ninja/poe1/pob/…) reuse the character
// sheet's React `char` object, but the items inside it are not GGG's API
// schema. PoB writes property lines into explicitMods, parks flasks and jewels
// in MainInventory, leaves properties/sockets empty, and names gems after the
// skill so copies collapse into one.
//
// These helpers turn that back into the shape slim() and the rest of the
// pipeline already understand. page-bridge.js keeps a copy — it cannot import,
// being a MAIN-world classic script — and tools/check-wiring.mjs compares them.

/** Property lines PoB stuffs into explicitMods. Real modifiers never look like this. */
export const POB_HEADER_LINE =
  /^(Armour|Evasion Rating|Energy Shield|Ward|Quality|Sockets|Limited to|Radius|Item Level|Requires|LevelReq|Unique ID)\s*:/i;

/**
 * The flask base hiding inside a magic name.
 *
 * PoB sets `baseType` to "Masochist's Ruby Flask of the Cheetah". Trade searches
 * flasks by base, so that string finds nothing. Unique flasks already carry the
 * real base ("Granite Flask") and this leaves them alone.
 */
export const FLASK_BASE =
  /\b(Quicksilver|Diamond|Ruby|Sapphire|Topaz|Granite|Jade|Quartz|Silver|Basalt|Aquamarine|Stibnite|Sulphur|Bismuth|Gold|Corundum|Iron|Amethyst|Life|Mana|Hybrid) Flask\b/i;

export function stripPobHeaders(mods) {
  return (mods || []).filter((text) => !POB_HEADER_LINE.test(String(text).trim()));
}

/**
 * PoB wraps a long modifier onto the next line. Trade indexes the whole
 * sentence as one stat, so a split copy matches nothing.
 *
 * Impossible Escape is the one that made this visible: the keystone arrives as
 *
 *   Passive Skills in Radius of Chaos Inoculation can be Allocated
 *   without being connected to your tree
 *   Passage
 *
 * and "Passage" is part of the official wording, not leftover flavour.
 * A continuation starts with a lowercase letter, or is that one word.
 */
export function joinWrappedMods(mods) {
  const out = [];
  for (const raw of mods || []) {
    const text = String(raw).trim();
    if (!text) continue;
    if (out.length && (/^[a-z]/.test(text) || /^Passage$/i.test(text))) {
      out[out.length - 1] = `${out[out.length - 1]} ${text}`;
      continue;
    }
    out.push(text);
  }
  return out;
}

/** "Sockets: B-G-B-B-W-W" -> 6; "Sockets: A A" -> 1. */
export function linksFromSocketLine(mods) {
  const line = (mods || []).find((text) => /^Sockets\s*:/i.test(String(text).trim()));
  if (!line) return 0;
  const groups = String(line).replace(/^Sockets\s*:\s*/i, '').trim().split(/\s+/).filter(Boolean);
  return Math.max(0, ...groups.map((group) => group.split('-').filter(Boolean).length), 0);
}

export function defencesFromModLines(mods) {
  const read = (label) => {
    const line = (mods || []).find((text) => new RegExp(`^${label}\\s*:`, 'i').test(String(text).trim()));
    if (!line) return 0;
    return parseInt(String(line).replace(/[^\d]/g, ''), 10) || 0;
  };
  return {
    ar: read('Armour'),
    ev: read('Evasion Rating'),
    es: read('Energy Shield'),
    ward: read('Ward'),
    block: 0,
  };
}

export function flaskBaseType(item) {
  const current = item.baseType || '';
  if (FLASK_BASE.test(current) && current.trim().length === current.match(FLASK_BASE)[0].length) {
    return current;
  }
  const fromName = `${current} ${item.typeLine || ''}`.match(FLASK_BASE);
  return fromName ? fromName[0] : current;
}

/**
 * PoB parks flasks and jewels in MainInventory. The rest of the extension
 * branches on Flask / PassiveJewels, so a paste would otherwise dump them all
 * into "Other" and search jewels as if they were belts.
 */
export function slotOf(item) {
  const slot = item.inventoryId || null;
  if (slot && slot !== 'MainInventory') return slot;
  const base = `${item.baseType || ''} ${item.typeLine || ''}`;
  if (/\bflask\b/i.test(base)) return 'Flask';
  if (/\bjewel\b/i.test(base)) return 'PassiveJewels';
  return slot;
}

/**
 * An id that actually distinguishes two items on the same paste.
 *
 * Character-page items have GGG's hex id. PoB uniques carry "Unique ID: …".
 * Everything else — rares identified by a defence line, gems named after the
 * skill — is not unique, and the caller must not treat it as a seen-key.
 */
export function stableId(item) {
  const id = String(item.id || '');
  if (id.startsWith('Unique ID:')) return id;
  if (/^[0-9a-f]{20,}$/i.test(id)) return id;
  return null;
}

/** Drops an explicit that PoB also copied into implicits. */
export function withoutImplicitDupes(explicit, implicit) {
  const have = new Set((implicit || []).map((text) => String(text).trim().toLowerCase()));
  return (explicit || []).filter((text) => !have.has(String(text).trim().toLowerCase()));
}

/**
 * Gem level/quality live on char.skills[].allGems, not on the item JSON the
 * fiber walk sees. Queued by skill name so each copy on the page can take one.
 */
export function gemStatQueues(skills) {
  const queues = new Map();
  for (const skill of skills || []) {
    for (const gem of skill.allGems || []) {
      const data = gem.itemData || {};
      const name = gem.name || data.baseType || data.typeLine;
      if (!name) continue;
      if (!queues.has(name)) queues.set(name, []);
      const level = gem.level ?? null;
      const quality = gem.quality ?? 0;
      queues.get(name).push({
        level,
        quality,
        support: !!data.support || /\bSupport$/i.test(name),
        corrupted: gemImpliesCorruption({
          name,
          level,
          quality,
          corrupted: !!gem.corrupted || !!data.corrupted,
        }),
      });
    }
  }
  return queues;
}

export function takeGemStats(queues, item) {
  const name = item.baseType || item.typeLine || item.name;
  const queue = queues.get(name);
  if (!queue || !queue.length) {
    return {
      level: null,
      quality: 0,
      support: !!item.support || /\bSupport$/i.test(name || ''),
      corrupted: gemImpliesCorruption({
        name: name || '',
        level: item.gemLevel,
        quality: item.gemQuality,
        corrupted: !!item.corrupted,
      }),
    };
  }
  return queue.shift();
}

/**
 * PoB (and sometimes the item JSON) omits `corrupted` on gems. The rolls still
 * give it away: a gem cannot reach these numbers without Vaal.
 *
 *   quality > 20
 *   level > 20                    — ordinary gems
 *   Empower / Enlighten / Enhance — uncorrupted max is 3
 *   Awakened                      — uncorrupted max is 5, including Awakened Enlighten
 */
export function gemImpliesCorruption(gem) {
  const { name = '', level = 0, quality = 0, corrupted = false } = gem || {};
  if (corrupted) return true;
  if (Number(quality) > 20) return true;
  const lvl = Number(level) || 0;
  if (!lvl) return false;
  const label = String(name);
  if (/\bawakened\b/i.test(label)) return lvl > 5;
  if (/\b(empower|enlighten|enhance)(\s+support)?$/i.test(label)) return lvl > 3;
  return lvl > 20;
}
