// Traduce el texto de un modificador ("+138 to maximum Life") al identificador
// que entiende la API de trade ("explicit.stat_3299347043").
//
// GGG publica las plantillas en /api/trade/data/stats con `#` donde va el
// número. Normalizamos ambos lados y comparamos.

const STATS_URL = 'https://www.pathofexile.com/api/trade/data/stats';

/** Los stat id sólo cambian con los parches, así que la caché puede ser larga. */
const TTL_MS = 24 * 60 * 60 * 1000;

/** Campo del ítem -> tipo de stat en la API de trade. */
export const MOD_FIELDS = [
  ['enchantMods', 'enchant'],
  ['implicitMods', 'implicit'],
  ['fracturedMods', 'fractured'],
  ['craftedMods', 'crafted'],
  ['explicitMods', 'explicit'],
];

function norm(text) {
  return String(text)
    .replace(/-?\d+(?:\.\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * El signo puede estar dentro del hueco o fuera según la plantilla: el ítem
 * dice "-1 Prefix Modifier allowed" y GGG lo llama "+# Prefix Modifier
 * allowed". Indexamos y buscamos también sin signo.
 */
function sinSigno(clave) {
  return clave.replace(/[+-]#/g, '#');
}

/** Las plantillas de defensas llevan "(Local)"; el texto del ítem no. */
function sinLocal(clave) {
  return clave.replace(/\s*\(local\)$/, '');
}

export function valuesOf(text) {
  return (String(text).match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
}

async function fetchStats() {
  const cache = await chrome.storage.local.get('tradeStats');
  const entry = cache.tradeStats;
  if (entry && Date.now() - entry.at < TTL_MS) return entry.data;

  const res = await fetch(STATS_URL);
  if (!res.ok) throw new Error(`Trade stats devolvió ${res.status}`);
  const data = await res.json();
  await chrome.storage.local.set({ tradeStats: { at: Date.now(), data } });
  return data;
}

let indice = null;

/** Mapa `tipo -> clave normalizada -> stat id`, más el grupo `pseudo` aparte. */
export async function loadStatIndex() {
  if (indice) return indice;
  const data = await fetchStats();

  const porTipo = new Map();
  const pseudo = new Map();

  for (const grupo of data.result || []) {
    for (const e of grupo.entries || []) {
      const tipo = e.type || grupo.id;
      if (tipo === 'pseudo') pseudo.set(e.id, e);
      if (!porTipo.has(tipo)) porTipo.set(tipo, new Map());
      const mapa = porTipo.get(tipo);
      // Varias claves para el mismo id: con y sin "(Local)", con y sin signo.
      for (const clave of new Set([
        norm(e.text),
        sinLocal(norm(e.text)),
        sinSigno(norm(e.text)),
        sinSigno(sinLocal(norm(e.text))),
      ])) {
        if (!mapa.has(clave)) mapa.set(clave, e.id);
      }
    }
  }

  indice = { porTipo, pseudo };
  return indice;
}

/** Busca el stat id de un modificador. Devuelve null si no lo reconocemos. */
export function matchMod(index, text, tipo) {
  const mapa = index.porTipo.get(tipo);
  if (!mapa) return null;
  const clave = norm(text);
  const id =
    mapa.get(clave) ??
    mapa.get(sinLocal(clave)) ??
    mapa.get(sinSigno(clave)) ??
    mapa.get(sinSigno(sinLocal(clave)));
  if (!id) return null;
  return { id, values: valuesOf(text) };
}

const RES_ELEMENTAL = /^\+(-?\d+)% to (Fire|Cold|Lightning) Resistance$/;
const RES_DOBLE = /^\+(-?\d+)% to (\w+) and (\w+) Resistances$/;
const RES_TODAS = /^\+(-?\d+)% to all Elemental Resistances$/;

/**
 * Resistencia elemental total del ítem, sumando las combinadas y las de "todas".
 * Es el pseudo-mod que de verdad usa la gente al buscar equipo.
 */
export function totalElementalResistance(item) {
  let total = 0;
  for (const [campo] of MOD_FIELDS) {
    for (const mod of item[campo] || []) {
      let m = RES_ELEMENTAL.exec(mod);
      if (m) { total += Number(m[1]); continue; }
      m = RES_TODAS.exec(mod);
      if (m) { total += Number(m[1]) * 3; continue; }
      m = RES_DOBLE.exec(mod);
      if (m && /fire|cold|lightning/i.test(m[2]) && /fire|cold|lightning/i.test(m[3])) {
        total += Number(m[1]) * 2;
      }
    }
  }
  return total;
}

const VIDA_PLANA = /^\+(-?\d+) to maximum Life$/;

export function totalLife(item) {
  let total = 0;
  for (const [campo] of MOD_FIELDS) {
    for (const mod of item[campo] || []) {
      const m = VIDA_PLANA.exec(mod);
      if (m) total += Number(m[1]);
    }
  }
  return total;
}

/**
 * Modificadores que de verdad mueven el precio, en orden. Todo lo demás se
 * ignora: meter los seis mods de un raro en la query devuelve cero resultados.
 */
const PRIORIDAD = [
  /chance to Suppress Spell Damage/i,
  /to Level of all .*Skill Gems/i,
  /increased Movement Speed/i,
  /to Global Critical Strike Multiplier/i,
  /increased Critical Strike Chance/i,
  /increased Attack Speed/i,
  /increased Cast Speed/i,
  /increased Spell Damage/i,
  /to maximum Energy Shield/i,
  /increased .*Evasion and Energy Shield/i,
  /increased Effect of Tailwind/i,
  /to Accuracy Rating/i,
];

/** Elige los mods significativos del ítem, ya traducidos a stat id. */
export function significantMods(index, item, limite) {
  const salida = [];
  for (const patron of PRIORIDAD) {
    if (salida.length >= limite) break;
    for (const [campo, tipo] of MOD_FIELDS) {
      if (salida.length >= limite) break;
      for (const mod of item[campo] || []) {
        if (!patron.test(mod)) continue;
        const hit = matchMod(index, mod, tipo);
        // Dedupe por el número del stat, no por el id completo: el mismo mod
        // fracturado y explícito son `fractured.stat_123` y `explicit.stat_123`,
        // y meter los dos gasta un hueco de filtro sin acotar nada.
        const numero = (id) => id.replace(/^[a-z]+\./, '');
        if (!hit || salida.some((s) => numero(s.id) === numero(hit.id))) continue;
        salida.push({ ...hit, text: mod });
        break;
      }
    }
  }
  return salida;
}
