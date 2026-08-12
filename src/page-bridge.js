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

  const idOf = (item) => item.id || `${item.baseType}:${item.x},${item.y}`;

  /**
   * The full equipment list, both weapon sets included, as poe.ninja hands it to
   * the page component before deciding what to paint.
   *
   * The walk below only reaches what is on screen, and the swap set is not:
   * React mounts it when you press the "II" toggle over the weapon. So a bow and
   * quiver parked in weapon set II were priced as if the character had nothing
   * there, which is the whole of the "secondary weapon set" bug.
   *
   * It has to be climbed to, not walked into. The list sits two fibers *above*
   * the <article> we start from — article, main, then the component holding
   * `char` — so nothing below the starting point ever sees it.
   */
  function charOf(fiber) {
    for (let node = fiber, guard = 0; node && guard < 40; guard++, node = node.return) {
      const char = node.memoizedProps?.char;
      if (char && Array.isArray(char.items)) return char;
    }
    return null;
  }

  function equipmentList(char) {
    return (char?.items || []).map((entry) => entry?.itemData).filter(isItem);
  }

  /**
   * What the character bought that is not an item.
   *
   * Tattoos and runegrafts are applied to the passive tree, so they never
   * appear in `items` and had no way into the total — on the character this was
   * measured on that was 28 tattoos and 2 runegrafts, and one of the runegrafts
   * alone was worth seven divine.
   *
   * `useSecondWeaponSet` comes along because poe.ninja already answers the
   * question the swap-set switch was guessing at.
   */
  function buildExtras(char) {
    const named = (list) => (Array.isArray(list) ? list : [])
      .map((entry) => entry?.name)
      .filter((name) => typeof name === 'string' && name);

    return {
      useSecondWeaponSet: Boolean(char?.useSecondWeaponSet),
      tattoos: named(char?.tattoos),
      runegrafts: named(char?.runegrafts),
    };
  }

  /**
   * Walks the fiber tree looking for items in props, then tops it up from the
   * equipment list for anything the page is holding but not painting.
   *
   * `socketedItems` (the gems inside gear) are flattened separately because they
   * hang off the containing item and have no fiber of their own.
   */
  function harvest(root) {
    const found = [];
    const seen = new Set();
    const startFiber = fiberOf(root);
    const char = charOf(startFiber);
    const stack = [startFiber].filter(Boolean);
    let guard = 0;

    const flattenGems = (item, id) => {
      for (const gem of item.socketedItems || []) {
        const gemId = gem.id || `${id}:${gem.socket}`;
        if (seen.has(gemId)) continue;
        seen.add(gemId);
        found.push(slim(gem, found.length, null));
      }
    };

    while (stack.length && guard++ < 200000) {
      const fiber = stack.pop();
      if (!fiber) continue;
      if (fiber.child) stack.push(fiber.child);
      if (fiber.sibling) stack.push(fiber.sibling);

      const props = fiber.memoizedProps;
      if (!props || typeof props !== 'object') continue;

      for (const value of Object.values(props)) {
        if (!isItem(value)) continue;
        const id = idOf(value);
        if (seen.has(id)) continue;
        seen.add(id);

        const el = hostElement(fiber);
        if (el) el.setAttribute(ATTR, String(found.length));
        found.push(slim(value, found.length, el ? found.length : null));
        flattenGems(value, id);
      }
    }

    // Whatever the walk already caught keeps its anchor; only the unpainted
    // slots come from here, and those get none. With the set hidden there is no
    // element to hang a badge on — they still count towards the total, which is
    // what the bug was about.
    //
    // Their socketed gems deliberately do not. A swap weapon is where players
    // park spare Empowers to level, and the character page shows nine of them in
    // one bow and quiver — pricing storage as if it were the build would have
    // moved the total by more than the weapons themselves.
    for (const item of equipmentList(char)) {
      const id = idOf(item);
      if (seen.has(id)) continue;
      seen.add(id);
      found.push(slim(item, found.length, null));
    }

    return { items: found, build: buildExtras(char) };
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
      // GGG's own flag, so the panel can say "Support gem" without deciding it
      // from a name ending in " Support" — which is a guess, and an English one.
      support: !!item.support,
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
    let harvested = { items: [], build: null };
    try {
      harvested = harvest(root);
    } catch (err) {
      window.postMessage({ source: 'pnc-bridge', error: String(err && err.message) }, '*');
      return;
    }
    window.postMessage(
      { source: 'pnc-bridge', items: harvested.items, build: harvested.build },
      '*',
    );
  }

  // ------------------------------------------------------- console helpers
  //
  // `pncDiagnose()` typed into the console never resolved, and the README told
  // people to type it: DevTools evaluates in the page's world, and a content
  // script's globals live in an isolated one, so the name does not exist there.
  // This file is the one part of the extension that *does* run in the page's
  // world, so the names live here and the call is forwarded.

  let callId = 0;
  const waiting = new Map();

  const consoleCall = (name) => () => new Promise((resolve, reject) => {
    const id = ++callId;
    waiting.set(id, resolve);
    window.postMessage({ source: 'pnc-console-request', name, id }, '*');
    setTimeout(() => {
      if (!waiting.delete(id)) return; // already answered
      reject(new Error('The extension did not answer. Is this a character page?'));
    }, 10000);
  });

  window.pncReport = consoleCall('report');
  window.pncDiagnose = consoleCall('diagnose');

  // The content script asks for the harvest when the user clicks the button, so
  // we don't walk React's tree on every page load.
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    if (ev.data?.source === 'pnc-request') publish();
    if (ev.data?.source === 'pnc-console-reply') {
      const resolve = waiting.get(ev.data.id);
      if (!resolve) return;
      waiting.delete(ev.data.id);
      resolve(ev.data.result);
    }
  });
})();
