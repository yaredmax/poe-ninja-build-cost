// Content script: detecta los ítems ya renderizados en la página de personaje
// y les pega el precio al lado.
//
// IMPORTANTE — por qué esto no llama a la API de builds de poe.ninja:
// la documentación (https://poe.ninja/docs/api) dice explícitamente que los
// endpoints de builds / profiles / character son internos y NO están permitidos
// para terceros. Así que no los tocamos. Leemos lo que la propia página ya ha
// pintado en el DOM, lo cual no genera ni una sola petición extra contra
// poe.ninja, y respeta a los jugadores que ocultan su perfil: si la web no lo
// muestra, nosotros tampoco lo vemos.

const PANEL_ID = 'pnc-panel';
const BADGE_CLASS = 'pnc-badge';

/** Igual que `normalizeName` en lib/economy.js: los dos lados deben coincidir. */
function normalizeName(raw) {
  return String(raw)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’'`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * La misma build se puede abrir por tres rutas distintas:
 *   /poe1/builds/streamers/character/{cuenta}/{personaje}
 *   /poe1/builds/{liga}/character/{cuenta}/{personaje}
 *   /poe1/profile/{cuenta}/{liga}/character/{personaje}
 * Lo único común es el segmento `/character/`, así que es lo que miramos.
 */
function isCharacterPage() {
  return /^\/poe1\/(builds|profile)\/.*\/character\//.test(location.pathname);
}

/**
 * Slug de liga sacado de la URL, cuando está. En las rutas de streamers no
 * aparece, y entonces dejamos que el service worker use la liga por defecto.
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

// ---------------------------------------------------------------- escaneo DOM

/**
 * Textos candidatos a ser nombre de ítem, con el elemento donde anclar el badge.
 *
 * No usamos selectores CSS de poe.ninja a propósito: son clases generadas por
 * el build de Astro y cambian en cada despliegue. En vez de eso comparamos el
 * texto contra los nombres que ya conocemos del índice de precios, que es
 * estable aunque el maquetado cambie entero.
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
 * En las listas de joyas poe.ninja escribe "nombre + baseType"
 * ("Watcher's Eye Prismatic Jewel"). Probamos el texto entero y luego le vamos
 * quitando palabras por el final, pero sólo cuando acaba en un tipo de base
 * conocido: si no, un nombre de raro aleatorio podría colar por casualidad.
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
 * Nivel y calidad de una gema. En el DOM el nombre está en su propio <span> y
 * el "4 / 20" cuelga de un ancestro, así que subimos un par de niveles y
 * leemos el texto que sigue al nombre.
 */
function gemLevelQuality(el, name) {
  for (let node = el.parentElement, depth = 0; node && depth < 3; node = node.parentElement, depth++) {
    const text = node.textContent.trim();
    if (!text.toLowerCase().startsWith(name.toLowerCase())) continue;

    // "Cast On Critical Strike Support (trigger) 20 / 20"
    const rest = text.slice(name.length).trim().replace(/^\([^)]*\)\s*/, '');

    // Anclado al final a propósito. El bloque de DPS repite el nombre de la
    // skill seguido de otras cifras ("Blade Blast 2.2/s · 900% crit"), y sin
    // anclar leeríamos "2" como nivel de gema.
    const m = rest.match(/^(\d+)(?:\s*\/\s*(\d+))?$/);
    if (m) return { level: Number(m[1]), quality: m[2] ? Number(m[2]) : 0 };
  }
  return null;
}

/**
 * Ajusta el precio de una gema al nivel/calidad que muestra la página.
 *
 * Devuelve `null` si es una gema y no hay nivel legible: eso significa que no
 * estamos en la lista de skills sino en el bloque de DPS, que repite los mismos
 * nombres. Sin esto, cada gema del setup principal se contaría dos veces.
 */
function refineGem(entry, el) {
  if (!entry.gems?.length) return entry;
  const lq = gemLevelQuality(el, entry.name);
  if (!lq) return null;

  const exact = entry.gems.find(([lvl, q]) => lvl === lq.level && q === lq.quality);
  const sameLevel = entry.gems.filter(([lvl]) => lvl === lq.level);
  const hit = exact || sameLevel[0];
  if (!hit) return entry;

  return { ...entry, chaos: hit[3], variantCount: 0, gem: `${lq.level}/${lq.quality}` };
}

// ------------------------------------------------- vía principal: page-bridge

/** Pide al script del mundo MAIN el JSON real de los ítems de la página. */
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

const ES_UNICO = (item) => item.frameType === 3 || item.frameType === 10;
const ES_GEMA = (item) => item.frameType === 4;

/** Elige la línea de precio que corresponde al ítem concreto. */
function priceForItem(item, index) {
  const clave = normalizeName(ES_GEMA(item) ? item.baseType : item.name);
  const entry = index[clave];
  if (!entry) return null;

  if (ES_GEMA(item) && entry.gems?.length) {
    const nivel = item.gemLevel;
    const calidad = item.gemQuality;
    const exacta = entry.gems.find(
      ([l, q, c]) => l === nivel && q === calidad && c === (item.corrupted ? 1 : 0),
    );
    const porNivel = entry.gems.filter(([l]) => l === nivel);
    const hit = exacta || porNivel[0];
    if (hit) return { ...entry, chaos: hit[3], variantCount: 0, detalle: `${nivel}/${calidad}` };
    return entry;
  }

  if (ES_UNICO(item) && entry.uniq?.length) {
    const corrupto = item.corrupted ? 1 : 0;
    const exacta = entry.uniq.find(([l, c]) => l === item.links && c === corrupto);
    const porLinks = entry.uniq.filter(([l]) => l === item.links);
    const hit = exacta || porLinks[0];
    if (hit) {
      const detalle = item.links >= 5 ? `${item.links}L` : null;
      return { ...entry, chaos: hit[2], variantCount: 0, detalle };
    }
  }

  return entry;
}

const HUECOS_EQUIPO = new Set([
  'Helm', 'BodyArmour', 'Boots', 'Gloves', 'Weapon', 'Weapon2',
  'Offhand', 'Ring', 'Ring2', 'Amulet', 'Belt',
]);

/**
 * Categoría para el desglose del resumen.
 *
 * Con el puente basta mirar el hueco donde va equipado. Por la vía de respaldo
 * no hay datos del ítem, sólo el nombre de la línea de precio, así que se
 * deduce del baseType y lo que no encaje cae en "Otros".
 */
function categoriaDe(match) {
  const item = match.item;
  if (item) {
    if (ES_GEMA(item)) return 'Gemas';
    if (item.inventoryId === 'Flask') return 'Flasks';
    if (item.inventoryId === 'PassiveJewels') return 'Joyas';
    if (HUECOS_EQUIPO.has(item.inventoryId)) return 'Equipamiento';
    return 'Otros';
  }
  if (match.price?.gems) return 'Gemas';
  const base = match.price?.baseType || '';
  if (/\bjewel\b/i.test(base)) return 'Joyas';
  if (/\bflask\b/i.test(base)) return 'Flasks';
  return base ? 'Equipamiento' : 'Otros';
}

function scanFromBridge(items, index) {
  const found = [];
  for (const item of items) {
    if (item.ancla == null) continue;
    const el = document.querySelector(`[data-pnc-item="${item.ancla}"]`);
    if (!el) continue;

    const price = priceForItem(item, index);
    // Un único sin precio no es lo mismo que un raro: el raro no puede tenerlo
    // (mods aleatorios), el único simplemente no está en la economía de
    // poe.ninja — como Skin of the Lords, que sólo existe corrupto y vale según
    // el keystone que otorgue. En ese caso el botón de trade sí sirve.
    const motivo = price ? null : ES_UNICO(item) ? 'no-cotizado' : 'aleatorio';
    found.push({ el, item, price, motivo });
  }
  return found;
}

/** Descarta anclas solapadas: si ya marcamos un padre o un hijo, no repetimos. */
function overlaps(accepted, el) {
  return accepted.some((m) => m.el === el || m.el.contains(el) || el.contains(m.el));
}

/**
 * Raíz del escaneo: el `<article>` con la ficha del personaje.
 *
 * Es imprescindible acotar. El pie de página lleva el diálogo de consentimiento
 * con cientos de nombres de vendors publicitarios, y algunos ("Impact",
 * "Momentum", "Signal") coinciden con nombres reales de ítems de PoE. Escanear
 * `document.body` entero mete precios inventados en el resumen.
 */
function scanRoot() {
  return document.querySelector('article') || document.body;
}

/** ¿Ya hay una coincidencia del mismo ítem en la misma tarjeta que `el`? */
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

  // 1) por texto: joyas, gemas y todo lo que poe.ninja escribe con letras
  for (const { el, text } of textCandidates(root)) {
    const entry = lookupText(index, text);
    if (!entry) continue;
    if (overlaps(found, el)) continue;
    const price = refineGem(entry, el);
    if (!price) continue;
    found.push({ el, price });
  }

  // 2) por icono: el equipo se pinta sólo con imágenes, sin nombre en el DOM
  for (const img of root.querySelectorAll('img[src*="poecdn"]')) {
    if (img.closest(`#${PANEL_ID}`)) continue;
    const key = icons[artFilename(img.getAttribute('src'))];
    const entry = key && index[key];
    if (!entry) continue;
    if (overlaps(found, img)) continue;
    // El icono y el nombre de una gema viven en elementos hermanos, así que
    // `overlaps` no los ve como el mismo ítem: haría falta contarlo dos veces.
    if (alreadyInCard(found, img, entry.name)) continue;
    found.push({ el: img, price: entry, viaIcon: true });
  }

  return found;
}

// ------------------------------------------------------------------- pintado

function formatChaos(chaos, chaosPerDivine) {
  if (chaos == null) return '—';
  if (chaosPerDivine && chaos >= chaosPerDivine) {
    return `${(chaos / chaosPerDivine).toFixed(1)} div`;
  }
  return `${chaos < 10 ? chaos.toFixed(1) : Math.round(chaos)} c`;
}

/** Los nombres vienen de poe.ninja, pero acaban en innerHTML: los escapamos. */
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function clearBadges() {
  document.querySelectorAll(`.${BADGE_CLASS}`).forEach((n) => n.remove());
}

/**
 * Contenedor donde encajar un badge en esquina: la celda del icono.
 *
 * Subimos desde el ancla hasta encontrar algo con tamaño de icono. Si no lo
 * hay (una lista de texto, por ejemplo), devolvemos null y el badge va en línea.
 */
function contenedorIcono(el) {
  let node = el.tagName === 'IMG' ? el.parentElement : el;
  for (let i = 0; i < 4 && node; i++, node = node.parentElement) {
    const r = node.getBoundingClientRect();
    if (r.width >= 40 && r.height >= 40) return node;
  }
  return null;
}

/**
 * Coloca el badge. En equipo, joyas y flasks va superpuesto en la esquina
 * inferior derecha del icono, que es donde no tapa nada. Las gemas se listan
 * como texto, así que ahí va al lado del nombre.
 */
function colocarBadge(match, badge) {
  const enEsquina = categoriaDe(match) !== 'Gemas' && contenedorIcono(match.el);
  if (!enEsquina) {
    match.el.insertAdjacentElement('afterend', badge);
    return;
  }
  if (getComputedStyle(enEsquina).position === 'static') {
    enEsquina.style.position = 'relative';
  }
  badge.classList.add('pnc-badge--esquina');
  enEsquina.appendChild(badge);
}

function paintBadges(matches, chaosPerDivine) {
  for (const match of matches) {
    const { price, item } = match;

    if (!price) {
      const etiqueta = item?.name || item?.typeLine || 'Ítem';
      const marca = document.createElement('span');
      marca.className = `${BADGE_CLASS} pnc-badge--sinprecio`;
      marca.textContent = match.motivo === 'no-cotizado' ? 'sin cotizar' : 'sin precio';
      marca.title =
        match.motivo === 'no-cotizado'
          ? `${etiqueta}: poe.ninja no publica precio de este único.`
          : `${etiqueta}: tiene mods aleatorios, así que no existe "su" precio de mercado.`;
      colocarBadge(match, marca);
      continue;
    }
    const incierto = price.floor || price.variantCount > 1;

    const badge = document.createElement('span');
    badge.className = BADGE_CLASS;
    badge.textContent = (price.floor ? '≥ ' : '') + formatChaos(price.chaos, chaosPerDivine);

    if (price.floor) {
      badge.title =
        `${price.name}: el precio depende de la tirada del ítem. ` +
        `poe.ninja sólo publica el precio del más barato, así que esto es un suelo, no su valor.`;
    } else if (price.variantCount > 1) {
      const [min, max] = price.spread || [];
      badge.title =
        `${price.name}: ${price.variantCount} variantes` +
        (min ? ` (${Math.round(min)}c – ${Math.round(max)}c según la variante)` : '') +
        `. Se muestra la más vendida, que no tiene por qué ser ésta.`;
    } else {
      badge.title = `${price.name} — ${price.listings} listings en poe.ninja`;
    }

    if (price.detalle) badge.textContent += ` (${price.detalle})`;
    if (incierto) badge.classList.add('pnc-badge--warn');

    colocarBadge(match, badge);
  }
}


// --------------------------------------------------------------------- panel

function ensurePanel() {
  let panel = document.getElementById(PANEL_ID);
  if (panel) return panel;

  panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.innerHTML = `
    <div class="pnc-head">
      <strong>Precio de la build</strong>
      <button class="pnc-close" title="Cerrar">×</button>
    </div>
    <div class="pnc-body">
      <button class="pnc-run">Calcular precio</button>
      <button class="pnc-rares" hidden></button>
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
  panel.querySelector('.pnc-rares').addEventListener('click', appraiseRares);
  return panel;
}

function setStatus(text, kind = '') {
  const node = document.querySelector(`#${PANEL_ID} .pnc-status`);
  if (node) {
    node.textContent = text;
    node.className = `pnc-status ${kind}`;
  }
}

function renderSummary(matches, chaosPerDivine, failed) {
  const box = document.querySelector(`#${PANEL_ID} .pnc-summary`);
  if (!box) return;

  const priced = matches.filter((m) => typeof m.price?.chaos === 'number');
  const aleatorios = matches.filter((m) => !m.price && m.motivo !== 'no-cotizado');
  const noCotizados = matches.filter((m) => m.motivo === 'no-cotizado');
  // Sólo entran al total las tasaciones de raros en las que confiamos.
  const tasados = matches.filter((m) => m.tasacion?.fiable && m.tasacion.chaos);
  const dudosos = matches.filter((m) => m.tasacion && !m.tasacion.fiable && m.tasacion.chaos);
  const total =
    priced.reduce((sum, m) => sum + m.price.chaos, 0) +
    tasados.reduce((sum, m) => sum + m.tasacion.chaos, 0);
  const inciertos = priced.filter((m) => m.price.floor || m.price.variantCount > 1);

  const filas = [
    ...priced.map((m) => ({
      nombre: m.price.name,
      chaos: m.price.chaos,
      marca: m.price.floor ? '≥' : m.price.variantCount > 1 ? '±' : '',
      categoria: categoriaDe(m),
    })),
    ...tasados.map((m) => ({
      nombre: m.item.name || m.item.baseType,
      chaos: m.tasacion.chaos,
      marca: '≈',
      categoria: categoriaDe(m),
    })),
  ];

  // Los ítems repetidos van juntos: una build con nueve Raise Spectre iguales
  // no necesita nueve líneas idénticas. El importe de la fila es el del grupo.
  const repetidos = new Map();
  for (const fila of filas) {
    const clave = `${fila.categoria}|${fila.nombre}|${fila.marca}|${fila.chaos}`;
    const previo = repetidos.get(clave);
    if (previo) {
      previo.cantidad++;
      previo.chaos += fila.chaos;
    } else {
      repetidos.set(clave, { ...fila, cantidad: 1 });
    }
  }

  // Agrupamos y ordenamos por subtotal: primero donde está el dinero.
  const grupos = new Map();
  for (const fila of repetidos.values()) {
    if (!grupos.has(fila.categoria)) grupos.set(fila.categoria, []);
    grupos.get(fila.categoria).push(fila);
  }
  const secciones = [...grupos.entries()]
    .map(([nombre, items]) => ({
      nombre,
      items: items.sort((a, b) => b.chaos - a.chaos),
      unidades: items.reduce((s, f) => s + f.cantidad, 0),
      subtotal: items.reduce((s, f) => s + f.chaos, 0),
    }))
    .sort((a, b) => b.subtotal - a.subtotal);

  // Los únicos que poe.ninja no cotiza van en su propia sección al final: si
  // sólo salieran en una nota, parecería que la extensión se los ha comido.
  if (noCotizados.length) {
    secciones.push({
      nombre: 'Sin cotizar',
      unidades: noCotizados.length,
      subtotal: null,
      items: noCotizados.map((m) => ({
        nombre: m.item?.name || m.price?.name || 'Único',
        chaos: null,
        marca: '',
        cantidad: 1,
      })),
    });
  }

  const bloques = secciones
    .map(
      (s) => `
      <div class="pnc-cat">
        <div class="pnc-cat-head">
          <span>${escapeHtml(s.nombre)} <em>(${s.unidades})</em></span>
          <strong>${s.subtotal === null ? '—' : formatChaos(s.subtotal, chaosPerDivine)}</strong>
        </div>
        <table class="pnc-table">${s.items
          .map(
            (f) => `
          <tr>
            <td>${escapeHtml(f.nombre)}${f.cantidad > 1 ? ` <em class="pnc-x">×${f.cantidad}</em>` : ''}</td>
            <td class="pnc-num">${f.marca ? `<span class="pnc-warn">${f.marca}</span> ` : ''}${f.chaos === null ? '<span class="pnc-warn">—</span>' : formatChaos(f.chaos, chaosPerDivine)}</td>
          </tr>`,
          )
          .join('')}</table>
      </div>`,
    )
    .join('');

  box.innerHTML = `
    <div class="pnc-total pnc-total--cabecera">
      <span>Mínimo (${filas.length} ítems)</span>
      <strong>${formatChaos(total, chaosPerDivine)}</strong>
    </div>
    ${bloques}
    ${
      chaosPerDivine
        ? `<div class="pnc-note">1 div ≈ ${Math.round(chaosPerDivine)} c</div>`
        : ''
    }
    ${
      inciertos.length
        ? `<div class="pnc-note pnc-warn">${inciertos.length} ítem(s) marcados ≥ o ±: su precio depende de la tirada o de la variante y puede ser muchísimo mayor.</div>`
        : ''
    }
    ${
      tasados.length
        ? `<div class="pnc-note">${tasados.length} raro(s) marcados ≈ son el precio de
             ítems <em>parecidos</em> en trade, no de éstos: no existe el precio de un raro concreto.</div>`
        : ''
    }
    ${
      dudosos.length
        ? `<div class="pnc-note pnc-warn">${dudosos.length} raro(s) tasados pero fuera del total:
             la búsqueda devolvió demasiados o muy pocos similares como para fiarse.</div>`
        : ''
    }
    ${
      aleatorios.length - tasados.length - dudosos.length > 0
        ? `<div class="pnc-note">${aleatorios.length - tasados.length - dudosos.length} raro(s)/mágico(s)
             sin tasar. Usa el botón de tasación para buscarlos en trade.</div>`
        : ''
    }
    ${
      noCotizados.length
        ? `<div class="pnc-note pnc-warn">Los "sin cotizar" son únicos que poe.ninja no publica
             en su economía, normalmente porque su valor depende de algo que la economía no
             desglosa. Pueden valer mucho y no cuentan para el total.</div>`
        : ''
    }
    <div class="pnc-note">
      Es un <strong>mínimo</strong>, no el coste real: sólo se valora lo que poe.ninja
      publica en su economía (únicos, gemas, cluster jewels…).
    </div>
    ${
      failed?.length
        ? `<div class="pnc-note pnc-warn">No se pudo cargar: ${failed.map((f) => f.type).join(', ')}</div>`
        : ''
    }
  `;
}

// -------------------------------------------------------------------- acción

let running = false;

/** Estado del último cálculo, para que la tasación de raros pueda reusarlo. */
let ultimo = null;

/**
 * Qué raros merece la pena mandar a trade.
 *
 * Las joyas quedan fuera: una cluster jewel vale por los notables que otorga,
 * y eso no se filtra con los mods que leemos, así que gastaríamos peticiones
 * para devolver un precio inventado.
 */
function esTasable(item) {
  return !!item?.inventoryId && item.inventoryId !== 'PassiveJewels';
}

/**
 * Tasa los raros uno a uno contra trade.
 *
 * Va en serie y con espaciado (el service worker impone 4 s entre búsquedas)
 * porque GGG limita a 15 búsquedas por minuto y castiga pasarse con baneos de
 * hasta media hora. Cada ítem son una o dos búsquedas más un fetch.
 */
async function appraiseRares() {
  if (!ultimo || running) return;
  running = true;

  const boton = document.querySelector(`#${PANEL_ID} .pnc-rares`);
  const pendientes = ultimo.matches.filter((m) => m.motivo === 'aleatorio' && esTasable(m.item));
  let hechos = 0;

  for (const match of pendientes) {
    hechos++;
    if (boton) boton.textContent = `Tasando raros… ${hechos}/${pendientes.length}`;
    setStatus(`Buscando similares a ${match.item.name || match.item.baseType}…`);

    try {
      const res = await send('appraise', {
        item: match.item,
        league: ultimo.league,
        chaosPerDivine: ultimo.chaosPerDivine,
      });
      match.tasacion = res;
      updateRareBadge(match, ultimo.chaosPerDivine);
    } catch (err) {
      setStatus(`Tasación detenida: ${err.message}`, 'pnc-warn');
      break;
    }
  }

  if (boton) {
    boton.textContent = `Volver a tasar raros (${pendientes.length})`;
    boton.disabled = false;
  }
  renderSummary(ultimo.matches, ultimo.chaosPerDivine, ultimo.failed);
  setStatus(`Tasación terminada: ${hechos} de ${pendientes.length}.`);
  running = false;
}

/** Reemplaza el "sin precio" por la estimación (o por el motivo de no darla). */
function updateRareBadge(match, chaosPerDivine) {
  const badge = match.el.nextElementSibling;
  if (!badge?.classList.contains(BADGE_CLASS)) return;
  const t = match.tasacion;

  if (t.omitido || !t.chaos) {
    badge.textContent = 'sin datos';
    badge.title = t.omitido || 'La búsqueda no devolvió ofertas.';
    return;
  }

  badge.textContent = `≈ ${formatChaos(t.chaos, chaosPerDivine)}`;
  badge.classList.remove('pnc-badge--sinprecio');
  badge.classList.add(t.fiable ? 'pnc-badge--similar' : 'pnc-badge--warn');
  badge.title =
    `Mediana de las ofertas más baratas entre ${t.total} similares. ` +
    `Fiabilidad: ${t.fiabilidad}.` +
    (t.relajada ? ' Búsqueda relajada: sólo vida y resistencias.' : '') +
    (t.fiable ? '' : ' Demasiados o muy pocos resultados: no cuenta para el total.');
}

async function run() {
  if (running) return;
  running = true;
  clearBadges();
  setStatus('Cargando economía de poe.ninja…');

  try {
    const { index, icons, chaosPerDivine, failed, league } = await send('prices', {
      leagueSlug: leagueSlugFromUrl(),
    });
    setStatus(`Liga: ${league}. Leyendo los ítems de la página…`);

    // Vía principal: el JSON real que la página tiene en memoria. Si el puente
    // falla (poe.ninja cambia sus internals), caemos al escaneo por texto.
    const items = await askBridge();
    let matches;
    let via;
    if (items?.length) {
      matches = scanFromBridge(items, index);
      via = 'datos de la página';
    } else {
      matches = scanItems(index, icons);
      via = 'texto e iconos (respaldo)';
    }

    if (!matches.length) {
      setStatus(
        'No se reconoció ningún ítem. Abre la consola y ejecuta pncDiagnostico().',
        'pnc-warn',
      );
      return;
    }

    paintBadges(matches, chaosPerDivine);
    renderSummary(matches, chaosPerDivine, failed);
    ultimo = { matches, chaosPerDivine, league, failed };

    const raros = matches.filter((m) => m.motivo === 'aleatorio' && esTasable(m.item));
    const boton = document.querySelector(`#${PANEL_ID} .pnc-rares`);
    if (boton) {
      boton.hidden = !raros.length;
      boton.textContent = `Tasar ${raros.length} raro(s) en trade (~${Math.ceil((raros.length * 4.5) / 5) * 5} s)`;
    }

    const conPrecio = matches.filter((m) => m.price).length;
    setStatus(`${conPrecio} de ${matches.length} ítems con precio — vía ${via}.`);
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'pnc-warn');
  } finally {
    running = false;
  }
}

/**
 * Ayuda para calibrar el escaneo cuando poe.ninja cambia el maquetado:
 * vuelca en consola los textos cortos de la página para ver si los nombres de
 * ítem están realmente en el DOM y con qué forma.
 */
window.pncDiagnostico = function pncDiagnostico() {
  const textos = new Set();
  for (const { text } of textCandidates(document.body)) textos.add(text);
  const artes = new Set();
  for (const img of document.querySelectorAll('img[src*="poecdn"]')) {
    const art = artFilename(img.getAttribute('src'));
    if (art) artes.add(art);
  }
  const salida = { textos: [...textos], iconos: [...artes] };
  console.log('[PoENinjaChecker]', salida);
  return salida;
};

// ------------------------------------------------------------- ciclo de vida

function sync() {
  if (isCharacterPage()) {
    ensurePanel();
  } else {
    clearBadges();
    document.getElementById(PANEL_ID)?.remove();
  }
}

// poe.ninja es una SPA: la URL cambia sin recargar y hay que reaccionar a mano.
//
// Nada de parchear `history.pushState`: un content script vive en un realm
// aislado, así que el parche sólo afectaría a nuestra copia y las llamadas de
// la página pasarían de largo. Vigilar la URL es feo pero sí funciona.
let lastUrl = location.href;
setInterval(() => {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  sync();
}, 500);
window.addEventListener('popstate', sync);

sync();
