// Búsquedas en la web de trade oficial de GGG.
//
// El flujo es el que usa la propia poe.ninja: POST de la query al API, que
// devuelve un `id`, y con ese id se abre la web normal de trade. No leemos
// resultados ni precios de aquí — sólo abrimos la búsqueda para el usuario.
//
// Límites medidos en `X-Rate-Limit-Ip` (política `trade-search-request-limit`):
//   5 por 10 s (baneo 60 s), 15 por 60 s (baneo 300 s),
//   30 por 300 s (baneo 1800 s), 600 por 21600 s (baneo 3600 s)
// Como cada búsqueda nace de un click del usuario, aquí basta con no encadenar
// clicks: `MIN_GAP_MS` los separa y el 429 se informa en vez de reintentar.

const API = 'https://www.pathofexile.com/api/trade/search';
const WEB = 'https://www.pathofexile.com/trade/search';

/**
 * Separación mínima entre búsquedas. El límite que muerde al tasar una build
 * entera es 15 por minuto, o sea 4 s por ítem. Es el suelo de toda la cola.
 */
const MIN_GAP_MS = 5000;

let ultimaBusqueda = 0;

/**
 * Traduce un ítem a una query de trade.
 * Devuelve `null` para lo que todavía no sabemos buscar (raros y mágicos:
 * necesitan filtros por stat y pseudo-mods).
 *
 * NO ESTÁ CONECTADA A NADA ahora mismo: el botón "ir a trade" se quitó de la
 * interfaz porque se comportaba de forma rara. Se conserva junto con `search()`
 * porque está probada y devolverla es sólo volver a llamarlas.
 */
export function buildQuery(item) {
  const query = { status: { option: 'online' }, stats: [{ type: 'and', filters: [] }] };

  // gema
  if (item.frameType === 4) {
    query.type = item.baseType;
    const misc = { corrupted: { option: String(!!item.corrupted) } };
    if (item.gemLevel) misc.gem_level = { min: item.gemLevel, max: item.gemLevel };
    if (item.gemQuality) misc.quality = { min: item.gemQuality };
    query.filters = { misc_filters: { filters: misc } };
    return { query, sort: { price: 'asc' } };
  }

  // único (3) o foil (10)
  if ((item.frameType === 3 || item.frameType === 10) && item.name) {
    query.name = item.name;
    query.type = item.baseType;
    const filters = {
      misc_filters: { filters: { corrupted: { option: String(!!item.corrupted) } } },
    };
    if (item.links >= 5) {
      filters.socket_filters = { filters: { links: { min: item.links } } };
    }
    query.filters = filters;
    return { query, sort: { price: 'asc' } };
  }

  return null;
}

export function canSearch(item) {
  return buildQuery(item) !== null;
}

const PSEUDO_RES = 'pseudo.pseudo_total_elemental_resistance';
const PSEUDO_VIDA = 'pseudo.pseudo_total_life';

/**
 * Cuántos filtros de mod metemos además de los pseudo.
 *
 * Poco, a propósito. Cada filtro estrecha muchísimo: con cinco, los siete raros
 * de la build de prueba daban cero resultados.
 */
const MAX_FILTROS = 2;

/** Margen a la baja sobre las tiradas del ítem, para que haya resultados. */
const MARGEN = 0.9;

/**
 * Categoría de trade a partir del hueco donde va equipado.
 *
 * Buscar por base exacta no sirve: de "Focused Amulet" hay UN listado en toda
 * la liga, así que cualquier filtro extra da cero. La gente busca "un amuleto
 * cualquiera con estos mods", y eso es la categoría.
 */
const CATEGORIAS = {
  Helm: 'armour.helmet',
  BodyArmour: 'armour.chest',
  Boots: 'armour.boots',
  Gloves: 'armour.gloves',
  Offhand: 'armour.shield',
  Weapon: 'weapon',
  Weapon2: 'weapon',
  Ring: 'accessory.ring',
  Ring2: 'accessory.ring',
  Amulet: 'accessory.amulet',
  Belt: 'accessory.belt',
};

function categoryFor(item) {
  if (item.inventoryId === 'Offhand' && /quiver/i.test(item.baseType)) return 'armour.quiver';
  return CATEGORIAS[item.inventoryId] || null;
}

/**
 * Query para un raro. No busca *este* ítem — eso no existe en venta — sino
 * ítems parecidos: misma base y los mods que mueven el precio, pedidos al 90%
 * de la tirada. El resultado es "uno así cuesta X", no "éste vale X".
 */
export function buildRareQuery(item, statIndex, helpers, maxMods = MAX_FILTROS) {
  const { significantMods, totalElementalResistance, totalLife } = helpers;
  const filters = [];

  const res = totalElementalResistance(item);
  if (res >= 30) {
    filters.push({ id: PSEUDO_RES, value: { min: Math.floor(res * MARGEN) } });
  }
  const vida = totalLife(item);
  if (vida >= 40) {
    filters.push({ id: PSEUDO_VIDA, value: { min: Math.floor(vida * MARGEN) } });
  }

  for (const mod of maxMods > 0 ? significantMods(statIndex, item, maxMods) : []) {
    const filtro = { id: mod.id };
    const valor = mod.values[0];
    if (typeof valor === 'number') {
      filtro.value = { min: Math.floor(Math.abs(valor) * MARGEN) * Math.sign(valor || 1) };
    }
    filters.push(filtro);
  }

  if (!filters.length) return null;

  const categoria = categoryFor(item);
  const query = {
    status: { option: 'online' },
    stats: [{ type: 'and', filters }],
  };
  if (categoria) {
    query.filters = { type_filters: { filters: { category: { option: categoria } } } };
  } else {
    query.type = item.baseType; // sin categoría conocida, al menos acotamos la base
  }

  return { query, sort: { price: 'asc' } };
}

/**
 * Precios de las primeras ofertas de una búsqueda.
 * `/fetch` acepta hasta 10 ids por petición, así que con una basta.
 */
export async function fetchPrices(queryId, resultIds, chaosPerDivine) {
  const ids = resultIds.slice(0, 10);
  if (!ids.length) return [];

  const url = `https://www.pathofexile.com/api/trade/fetch/${ids.join(',')}?query=${encodeURIComponent(queryId)}`;
  const res = await fetch(url);
  if (res.status === 429) throw new Error('GGG está limitando las peticiones.');
  if (!res.ok) throw new Error(`Trade fetch devolvió ${res.status}`);

  const data = await res.json();
  const chaos = [];
  for (const linea of data.result || []) {
    const precio = linea?.listing?.price;
    if (!precio || typeof precio.amount !== 'number') continue;
    if (precio.currency === 'chaos') chaos.push(precio.amount);
    else if (precio.currency === 'divine' && chaosPerDivine) {
      chaos.push(precio.amount * chaosPerDivine);
    }
  }
  return chaos.sort((a, b) => a - b);
}

/** Lanza la búsqueda y devuelve el id y los ids de resultado, sin abrir nada. */
export async function runQuery(body, league) {
  const espera = MIN_GAP_MS - (Date.now() - ultimaBusqueda);
  if (espera > 0) await new Promise((r) => setTimeout(r, espera));
  ultimaBusqueda = Date.now();

  const res = await fetch(`${API}/${encodeURIComponent(league)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 429) {
    const retry = res.headers.get('Retry-After');
    throw new Error(`GGG limitando${retry ? `; reintenta en ${retry} s` : ''}.`);
  }
  if (!res.ok) throw new Error(`Trade devolvió ${res.status}`);
  const data = await res.json();
  return { id: data.id, result: data.result || [], total: data.total ?? 0 };
}

/**
 * Cuánto fiarse de una tasación, por el número de resultados.
 *
 * Muchos resultados significa que los filtros no acotaron nada: la mediana de
 * los diez más baratos entre 250 cascos "con vida y resistencias" es basura de
 * 1 c, no el precio del ítem. Pocos resultados tampoco valen: uno solo puede
 * ser un precio inventado. Sólo `alta` y `media` deberían sumarse a un total.
 */
export function reliability(total) {
  if (!total) return 'ninguna';
  if (total > 120) return 'baja';
  if (total < 3) return 'escasa';
  if (total > 40) return 'media';
  return 'alta';
}

export const FIABLE = new Set(['alta', 'media']);

/** Para decidir si un segundo intento mejoró o no. */
const RANGO = { alta: 4, media: 3, escasa: 2, baja: 1, ninguna: 0 };

export function isBetter(totalNuevo, totalViejo) {
  return RANGO[reliability(totalNuevo)] > RANGO[reliability(totalViejo)];
}

/**
 * Qué números de mod probar después del primer intento, en orden.
 *
 * Se baja o se sube de uno en uno según el problema: sin resultados hay que
 * aflojar, con doscientos hay que apretar. Un solo escalón no basta —hay ítems
 * que sólo aparecen con los pseudo a secas— pero tampoco conviene saltar
 * directamente al fondo, porque de 0 resultados se pasa a 250 de basura.
 *
 * Como mucho dos intentos extra: cada uno es una búsqueda más contra GGG.
 */
export function attemptPlan(total, maxMods) {
  if (total === 0) return [maxMods - 1, maxMods - 2].filter((n) => n >= 0);
  if (total > 120) return [maxMods + 1, maxMods + 2];
  return [];
}

export function webUrl(league, queryId) {
  return `${WEB}/${encodeURIComponent(league)}/${queryId}`;
}

/** Lanza la búsqueda y devuelve la URL de la web de trade para abrirla. */
export async function search(item, league) {
  const body = buildQuery(item);
  if (!body) throw new Error('Todavía no sabemos construir la búsqueda de este ítem.');

  const espera = MIN_GAP_MS - (Date.now() - ultimaBusqueda);
  if (espera > 0) await new Promise((r) => setTimeout(r, espera));
  ultimaBusqueda = Date.now();

  const res = await fetch(`${API}/${encodeURIComponent(league)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (res.status === 429) {
    const espera = res.headers.get('Retry-After');
    throw new Error(
      `GGG está limitando las peticiones${espera ? `. Reintenta en ${espera} s` : ''}.`,
    );
  }
  if (!res.ok) throw new Error(`Trade devolvió ${res.status}`);

  const data = await res.json();
  if (!data.id) throw new Error('Trade no devolvió ningún id de búsqueda.');
  return `${WEB}/${encodeURIComponent(league)}/${data.id}`;
}
