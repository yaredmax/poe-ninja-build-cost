// Puente al "mundo MAIN" de la página.
//
// poe.ninja guarda en la memoria de React el JSON completo de cada ítem, con el
// mismo esquema que la API oficial de GGG: explicitMods, craftedMods, sockets,
// ilvl, corrupted, properties... Eso es infinitamente mejor que adivinar
// nombres leyendo texto del DOM.
//
// Hace falta este fichero aparte porque un content script normal vive en un
// realm aislado y NO ve las propiedades que React cuelga de los nodos
// (`__reactFiber$…`). Sólo un script en el mundo de la página las alcanza.
//
// Sigue sin haber ni una petición extra contra poe.ninja: esto es exactamente
// lo mismo que la página ya se ha descargado y está pintando.

(() => {
  const ATTR = 'data-pnc-item';

  /** ¿Este objeto tiene pinta de ítem de GGG? */
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

  /** Primer elemento DOM real por debajo de un fiber, para anclar el badge. */
  function hostElement(fiber) {
    for (let node = fiber, guard = 0; node && guard < 40; guard++) {
      if (node.stateNode instanceof Element) return node.stateNode;
      node = node.child;
    }
    return null;
  }

  /**
   * Recorre el árbol de fibers buscando ítems en las props. Los `socketedItems`
   * (gemas engarzadas) se aplanan aparte porque cuelgan del ítem contenedor y
   * no tienen fiber propio.
   */
  function harvest(root) {
    const found = [];
    const vistos = new Set();
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
        if (vistos.has(id)) continue;
        vistos.add(id);

        const el = hostElement(fiber);
        if (el) el.setAttribute(ATTR, String(found.length));
        found.push(slim(value, found.length, el ? found.length : null));

        for (const gema of value.socketedItems || []) {
          const gid = gema.id || `${id}:${gema.socket}`;
          if (vistos.has(gid)) continue;
          vistos.add(gid);
          found.push(slim(gema, found.length, null));
        }
      }
    }
    return found;
  }

  /** Nos quedamos sólo con lo que hace falta para tasar y para enlazar a trade. */
  function slim(item, indice, ancla) {
    const props = {};
    for (const p of item.properties || []) {
      props[p.name] = p.values?.[0]?.[0] ?? null;
    }
    const grupos = {};
    for (const s of item.sockets || []) grupos[s.group] = (grupos[s.group] || 0) + 1;

    return {
      indice,
      ancla,
      id: item.id || null,
      name: item.name || '',
      typeLine: item.typeLine || '',
      baseType: item.baseType || '',
      frameType: item.frameType, // 0 normal, 1 magic, 2 rare, 3 unique, 4 gema
      ilvl: item.ilvl ?? null,
      corrupted: !!item.corrupted,
      identified: item.identified !== false,
      inventoryId: item.inventoryId || null,
      links: Math.max(0, ...Object.values(grupos), 0),
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

  function publicar() {
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

  // El content script pide la cosecha cuando el usuario pulsa el botón: así no
  // recorremos el árbol de React en cada carga de página.
  window.addEventListener('message', (ev) => {
    if (ev.source === window && ev.data?.source === 'pnc-request') publicar();
  });
})();
