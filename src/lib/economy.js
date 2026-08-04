// Acceso a la API de economía *documentada* de poe.ninja.
// Doc: https://poe.ninja/docs/api
//
// Reglas que la doc pide y que respetamos aquí:
//  - Los datos de PoE1 se refrescan ~cada 15 min y las respuestas se cachean ~5 min.
//    No tiene sentido pedir más a menudo, así que cacheamos en chrome.storage.
//  - User-Agent descriptivo (lo pone background.js con declarativeNetRequest).
//  - Volumen y concurrencia razonables (ver CONCURRENCY).

const BASE = 'https://poe.ninja/poe1/api/economy';

/** TTL de la caché local. La doc dice que los datos se refrescan ~cada 15 min. */
const TTL_MS = 10 * 60 * 1000;

/** Peticiones simultáneas máximas contra poe.ninja. */
const CONCURRENCY = 3;

/**
 * Categorías de `stash/current/item/overview` que pueden aparecer como equipo
 * en una build. El orden importa poco; se piden en paralelo limitado.
 */
export const GEAR_TYPES = [
  'UniqueWeapon',
  'UniqueArmour',
  'UniqueAccessory',
  'UniqueFlask',
  'UniqueJewel',
  'ForbiddenJewel',
  'UniqueRelic',
  'UniqueTincture',
  'ShrineBelt',
  'Wombgift',
  'ClusterJewel',
  'SkillGem',
  'ImbuedGem',
];

/**
 * Ítems cuyo precio publicado es un SUELO, no un precio real: el valor depende
 * de una tirada que la API de economía no desglosa en líneas separadas.
 *
 * La mayoría se detectan solos contando modificadores `optional` (ver
 * `isFloorPriced`): un único normal tiene 0, un Watcher's Eye tiene 87. Pero
 * algunos varían por algo que no es un mod — el keystone de un Impossible
 * Escape, el nodo de un jewel temporal — y esos hay que listarlos a mano.
 */
const FLOOR_PRICED = new Set([
  'impossible escape',
  'split personality',
  'forbidden flame',
  'forbidden flesh',
  'elegant hubris',
  'militant faith',
  'brutal restraint',
  'glorious vanity',
  'lethal pride',
  'that which was taken',
]);

/** Umbral de mods `optional` a partir del cual el precio es un suelo. */
const OPTIONAL_MODS_THRESHOLD = 4;

function isFloorPriced(line) {
  if (FLOOR_PRICED.has(normalizeName(line.name))) return true;
  const optional = (line.explicitModifiers || []).filter((m) => m.optional).length;
  return optional > OPTIONAL_MODS_THRESHOLD;
}

/** Normaliza un nombre de ítem para poder comparar texto del DOM con la API. */
export function normalizeName(raw) {
  return String(raw)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // marcas diacríticas combinantes
    .replace(/[’'`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

async function cacheGet(key) {
  const store = await chrome.storage.local.get(key);
  const entry = store[key];
  if (!entry) return null;
  if (Date.now() - entry.at > TTL_MS) return null;
  return entry.data;
}

async function cacheSet(key, data) {
  await chrome.storage.local.set({ [key]: { at: Date.now(), data } });
}

async function getJson(url, cacheKey) {
  if (cacheKey) {
    const hit = await cacheGet(cacheKey);
    if (hit) return hit;
  }
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`poe.ninja ${res.status} en ${url}`);
  const data = await res.json();
  if (cacheKey) await cacheSet(cacheKey, data);
  return data;
}

/** Lista de ligas de economía. La primera es la liga temporal actual. */
export async function fetchLeagues() {
  return getJson(`${BASE}/leagues`, 'leagues');
}

/** Overview de una categoría de ítems para una liga. */
async function fetchOverview(league, type) {
  const url = `${BASE}/stash/current/item/overview?league=${encodeURIComponent(league)}&type=${encodeURIComponent(type)}`;
  const data = await getJson(url, `ov:${league}:${type}`);
  return data.lines || [];
}

/** Ejecuta `tasks` con un límite de concurrencia, sin abortar si alguna falla. */
async function pooled(tasks, limit) {
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const index = cursor++;
      try {
        results[index] = { ok: true, value: await tasks[index]() };
      } catch (err) {
        results[index] = { ok: false, error: err };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * De todas las líneas que comparten nombre, elige la "representativa".
 *
 * poe.ninja publica una línea por combinación de variante / links / corrupción,
 * y no podemos saber desde el DOM cuál es la del personaje. Usamos la de mayor
 * `listingCount`: es la que más se vende, o sea la versión corriente del ítem.
 */
function pickRepresentative(lines) {
  return lines.reduce((best, line) =>
    (line.listingCount ?? 0) > (best.listingCount ?? 0) ? line : best,
  );
}

/**
 * Construye el índice que se manda al content script: un objeto plano
 * `nombre normalizado -> resumen de precio`. Se queda en unos pocos miles de
 * entradas, mucho más ligero que mandar las líneas completas.
 */
export async function buildPriceIndex(league) {
  const settled = await pooled(
    GEAR_TYPES.map((type) => () => fetchOverview(league, type).then((lines) => ({ type, lines }))),
    CONCURRENCY,
  );

  const failed = [];
  const byName = new Map();
  const gemNames = new Set();
  const forbidden = new Map();

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (!result.ok) {
      failed.push({ type: GEAR_TYPES[i], error: String(result.error.message || result.error) });
      continue;
    }
    const { type, lines } = result.value;
    for (const line of lines) {
      if (!line.name) continue;

      // Los jewels Forbidden se publican con el nombre del *pasivo* que otorgan
      // ("Ngamahu, Flame's Advance"), y la página del personaje enseña
      // "Forbidden Flame Crimson Jewel". Los agregamos por su variante y NO los
      // indexamos por nombre: si no, la lista de ascendencia del personaje
      // ("Deathmarked", "Mistwalker"...) casaría con el precio de un jewel.
      if (type === 'ForbiddenJewel') {
        if (line.variant) {
          const prev = forbidden.get(line.variant);
          if (!prev || (line.chaosValue ?? Infinity) < prev) {
            forbidden.set(line.variant, line.chaosValue ?? Infinity);
          }
        }
        continue;
      }

      const key = normalizeName(line.name);
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(line);
      if (type === 'SkillGem' || type === 'ImbuedGem') gemNames.add(key);
    }
  }

  const index = {};
  const icons = {};

  for (const [key, lines] of byName) {
    const pick = pickRepresentative(lines);
    const variants = new Set(lines.map((l) => l.variant).filter(Boolean));
    const entry = {
      name: pick.name,
      baseType: pick.baseType || null,
      chaos: pick.chaosValue ?? null,
      divine: pick.divineValue ?? null,
      listings: pick.listingCount ?? 0,
      variantCount: variants.size,
      spread: priceSpread(lines),
      floor: lines.some(isFloorPriced),
    };

    // Para gemas guardamos todas las tiradas de nivel/calidad: la página del
    // personaje muestra "Empower Support 4 / 20", así que sí podemos acertar
    // la línea exacta en vez de conformarnos con la más vendida.
    if (gemNames.has(key)) {
      entry.gems = lines
        .filter((l) => typeof l.chaosValue === 'number')
        .map((l) => [l.gemLevel ?? 0, l.gemQuality ?? 0, l.corrupted ? 1 : 0, l.chaosValue]);
    } else if (lines.length > 1) {
      // Únicos: poe.ninja publica línea por links y por corrupción. Con el JSON
      // real del ítem sabemos ambas cosas, así que podemos coger la que toca.
      entry.uniq = lines
        .filter((l) => typeof l.chaosValue === 'number')
        .map((l) => [l.links ?? 0, l.corrupted ? 1 : 0, l.chaosValue]);
    }

    index[key] = entry;

    // La página muestra "Watcher's Eye Prismatic Jewel": nombre + baseType.
    if (pick.baseType) {
      const withBase = normalizeName(`${pick.name} ${pick.baseType}`);
      if (!index[withBase]) index[withBase] = entry;
    }

    // El equipo se pinta sólo con iconos, sin texto. La API de economía trae la
    // misma URL de poecdn, así que indexamos por el nombre del fichero de arte.
    //
    // Joyas y gemas quedan fuera a propósito: la página siempre las escribe con
    // letras, y su arte es el de la *base*. Un Large Cluster Jewel raro y el
    // único "The Light of Meaning" comparten `AfflictionJewel.png`, así que
    // casar por icono ahí sólo produce precios inventados.
    const esJoyaOGema = entry.gems || /\bjewel\b/i.test(entry.baseType || '');
    const art = esJoyaOGema ? null : artFilename(pick.icon);
    if (art) {
      if (art in icons && icons[art] !== key) icons[art] = null;
      else icons[art] = key;
    }
  }

  for (const [variant, chaos] of forbidden) {
    const key = normalizeName(variant);
    if (index[key]) continue;
    index[key] = {
      name: variant,
      baseType: null,
      chaos: Number.isFinite(chaos) ? chaos : null,
      divine: null,
      listings: 0,
      variantCount: 0,
      spread: null,
      floor: true, // el precio real depende del pasivo concreto
    };
  }

  for (const art of Object.keys(icons)) {
    if (icons[art] === null) delete icons[art];
  }

  return { index, icons, failed, chaosPerDivine: estimateChaosPerDivine(byName) };
}

/** `.../b84147fcbd/AssassinationUnique2.png` -> `AssassinationUnique2.png` */
export function artFilename(iconUrl) {
  if (!iconUrl) return null;
  const file = String(iconUrl).split('?')[0].split('/').pop();
  return file && file.endsWith('.png') ? file : null;
}

/** Rango chaos [min, max] entre todas las variantes de un mismo nombre. */
function priceSpread(lines) {
  const values = lines.map((l) => l.chaosValue).filter((v) => typeof v === 'number' && v > 0);
  if (values.length < 2) return null;
  return [Math.min(...values), Math.max(...values)];
}

/**
 * Divine en chaos, deducido de las propias líneas (cada una trae chaosValue y
 * divineValue). Mediana de los ratios para no comerse ningún outlier.
 */
function estimateChaosPerDivine(byName) {
  const ratios = [];
  for (const lines of byName.values()) {
    for (const l of lines) {
      if (l.chaosValue > 0 && l.divineValue > 0) ratios.push(l.chaosValue / l.divineValue);
    }
  }
  if (!ratios.length) return null;
  ratios.sort((a, b) => a - b);
  return ratios[Math.floor(ratios.length / 2)];
}
