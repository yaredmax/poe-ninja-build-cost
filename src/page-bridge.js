// Bridge into the page's MAIN world.
//
// poe.ninja keeps the full JSON of every item in React's memory, using the same
// schema as GGG's official API: explicitMods, craftedMods, sockets, ilvl,
// corrupted, properties… That beats guessing item names from DOM text by a mile.
//
// This has to be a separate file because a normal content script lives in an
// isolated realm and cannot see the properties React hangs off DOM nodes
// (`__reactFiber$…`). Only a script running in the page's own world reaches them.
//
// Still zero extra requests to poe.ninja: this is exactly what the page has
// already downloaded and is busy painting.

(() => {
  const ATTR = 'data-pnc-item';

  /** Does this object look like a GGG item? */
  function isItem(value) {
    return (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof value.baseType === 'string' &&
      typeof value.frameType === 'number' &&
      (Array.isArray(value.explicitMods) || typeof value.typeLine === 'string')
    );
  }

  function fiberOf(el) {
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    return key ? el[key] : null;
  }

  /** First real DOM element below a fiber, used to anchor the badge. */
  function hostElement(fiber) {
    for (let node = fiber, guard = 0; node && guard < 40; guard++) {
      if (node.stateNode instanceof Element) return node.stateNode;
      node = node.child;
    }
    return null;
  }

  /**
   * Walks the fiber tree looking for items in props. `socketedItems` (the gems
   * inside gear) are flattened separately because they hang off the containing
   * item and have no fiber of their own.
   */
  function harvest(root) {
    const found = [];
    const seen = new Set();
    const stack = [fiberOf(root)].filter(Boolean);
    let guard = 0;

    while (stack.length && guard++ < 200000) {
      const fiber = stack.pop();
      if (!fiber) continue;
      if (fiber.child) stack.push(fiber.child);
      if (fiber.sibling) stack.push(fiber.sibling);

      const props = fiber.memoizedProps;
      if (!props || typeof props !== 'object') continue;

      for (const value of Object.values(props)) {
        if (!isItem(value)) continue;
        const id = value.id || `${value.baseType}:${value.x},${value.y}`;
        if (seen.has(id)) continue;
        seen.add(id);

        const el = hostElement(fiber);
        if (el) el.setAttribute(ATTR, String(found.length));
        found.push(slim(value, found.length, el ? found.length : null));

        for (const gem of value.socketedItems || []) {
          const gemId = gem.id || `${id}:${gem.socket}`;
          if (seen.has(gemId)) continue;
          seen.add(gemId);
          found.push(slim(gem, found.length, null));
        }
      }
    }
    return found;
  }

  const toNumber = (text) => parseFloat(String(text ?? '').replace(/[^\d.-]/g, '')) || 0;

  /** "50-100" and "5-10, 20-30" both collapse to the average of every range. */
  function average(text) {
    const ranges = String(text ?? '').match(/\d+(?:\.\d+)?-\d+(?:\.\d+)?/g);
    if (!ranges) return 0;
    let total = 0;
    for (const range of ranges) {
      const [lo, hi] = range.split('-').map(Number);
      total += (lo + hi) / 2;
    }
    return total;
  }

  const round1 = (n) => Math.round(n * 10) / 10;

  /** Keep only what pricing and trade queries actually need. */
  function slim(item, index, anchor) {
    const props = {};
    for (const p of item.properties || []) {
      props[p.name] = p.values?.[0]?.[0] ?? null;
    }
    const socketGroups = {};
    for (const s of item.sockets || []) {
      socketGroups[s.group] = (socketGroups[s.group] || 0) + 1;
    }

    return {
      index,
      anchor,
      id: item.id || null,
      name: item.name || '',
      typeLine: item.typeLine || '',
      baseType: item.baseType || '',
      frameType: item.frameType, // 0 normal, 1 magic, 2 rare, 3 unique, 4 gem, 10 foil
      ilvl: item.ilvl ?? null,
      corrupted: !!item.corrupted,
      identified: item.identified !== false,
      inventoryId: item.inventoryId || null,
      links: Math.max(0, ...Object.values(socketGroups), 0),
      sockets: (item.sockets || []).length,
      gemLevel: parseInt(props.Level, 10) || null,
      gemQuality: parseInt(String(props.Quality || '').replace('+', ''), 10) || 0,
      // The totals the item actually has, after its own modifiers and quality.
      // Searching these directly beats filtering on the flat and percentage
      // modifiers that produce them: one filter instead of two, and it matches
      // items that reach the same number a different way.
      //
      // Property names verified against a real build: "Armour", "Evasion
      // Rating", "Energy Shield", "Chance to Block", "Physical Damage",
      // "Attacks per Second", "Critical Strike Chance".
      defences: {
        ar: parseInt(props.Armour, 10) || 0,
        ev: parseInt(props['Evasion Rating'], 10) || 0,
        es: parseInt(props['Energy Shield'], 10) || 0,
        ward: parseInt(props.Ward, 10) || 0,
        block: parseInt(props['Chance to Block'], 10) || 0,
      },
      // The same five boxes Awakened PoE Trade shows for a weapon. Searching
      // these means the modifiers behind them — added damage, increased physical
      // damage, attack speed, crit chance — do not each need a filter slot.
      weapon: (() => {
        // "50-100" -> 75. Trade wants damage per second, so we need the average
        // of the range times the attack rate.
        const aps = toNumber(props['Attacks per Second']);
        const pdps = average(props['Physical Damage']) * aps;
        const edps = average(props['Elemental Damage']) * aps;
        return {
          dps: round1(pdps + edps),
          pdps: round1(pdps),
          edps: round1(edps),
          aps: round1(aps),
          crit: round1(toNumber(props['Critical Strike Chance'])),
        };
      })(),
      // Allflame's Foulborn mutation. The trade site calls the flag
      // "Foulborn" and exposes it as misc_filters.mutated.
      mutated: !!item.mutated || (item.mutatedMods || []).length > 0,
      mutatedMods: item.mutatedMods || [],
      implicitMods: item.implicitMods || [],
      explicitMods: item.explicitMods || [],
      craftedMods: item.craftedMods || [],
      fracturedMods: item.fracturedMods || [],
      enchantMods: item.enchantMods || [],
    };
  }

  function publish() {
    const root = document.querySelector('article');
    if (!root) return;
    let items = [];
    try {
      items = harvest(root);
    } catch (err) {
      window.postMessage({ source: 'pnc-bridge', error: String(err && err.message) }, '*');
      return;
    }
    window.postMessage({ source: 'pnc-bridge', items }, '*');
  }

  // The content script asks for the harvest when the user clicks the button, so
  // we don't walk React's tree on every page load.
  window.addEventListener('message', (ev) => {
    if (ev.source === window && ev.data?.source === 'pnc-request') publish();
  });
})();
