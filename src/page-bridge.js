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
