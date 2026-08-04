// Tasa los raros reales de una build contra la API de trade de verdad.
// Hace 2 peticiones por ítem (search + fetch) espaciadas 4 s: con 7 raros son
// ~30 s, muy por debajo de los límites de GGG.
//
//   node tools/rare-test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const store = new Map();
globalThis.chrome = { storage: { local: {
  async get(k) { return store.has(k) ? { [k]: store.get(k) } : {}; },
  async set(o) { for (const [k, v] of Object.entries(o)) store.set(k, v); } } } };

// En la extensión el User-Agent lo pone la regla de declarativeNetRequest.
// Aquí hay que ponerlo a mano: sin él, Cloudflare devuelve 403.
const UA = 'PoENinjaChecker/0.3 (personal build pricing extension)';
const fetchOriginal = globalThis.fetch;
globalThis.fetch = (url, init = {}) =>
  fetchOriginal(url, { ...init, headers: { ...(init.headers || {}), 'User-Agent': UA } });

const { loadStatIndex, significantMods, totalElementalResistance, totalLife, matchMod, MOD_FIELDS } =
  await import('../src/lib/stats.js');
const { buildRareQuery, runQuery, fetchPrices, reliability, FIABLE, isBetter, attemptPlan } =
  await import('../src/lib/trade.js');
const { fetchLeagues } = await import('../src/lib/economy.js');

const MODS_INICIALES = 2;
const rares = JSON.parse(readFileSync(join(here, 'fixtures', 'character-rares.json'), 'utf8')).items;
const league = (await fetchLeagues())[0].id;
const CHAOS_POR_DIV = 187;

const index = await loadStatIndex();

// 1) cobertura del mapeo texto -> stat id
let ok = 0, fail = 0;
const noReconocidos = [];
for (const item of rares) {
  for (const [campo, tipo] of MOD_FIELDS) {
    for (const mod of item[campo] || []) {
      if (matchMod(index, mod, tipo)) ok++;
      else { fail++; noReconocidos.push(`${tipo}: ${mod}`); }
    }
  }
}
console.log(`Mapeo de mods: ${ok}/${ok + fail}`);
if (noReconocidos.length) {
  console.log('  sin reconocer:');
  for (const n of noReconocidos) console.log(`    ${n}`);
}

// 2) tasación real
console.log(`\nLiga: ${league}\n`);
const fmt = (c) => (c >= CHAOS_POR_DIV ? `${(c / CHAOS_POR_DIV).toFixed(1)} div` : `${Math.round(c)} c`);
let suma = 0;
let tasados = 0;

for (const item of rares) {
  const helpers = { significantMods, totalElementalResistance, totalLife };
  let body = buildRareQuery(item, index, helpers, MODS_INICIALES);
  const cabecera = `${item.name} [${item.baseType}]`;
  if (!body) { console.log(`  ${cabecera}: sin mods filtrables`); continue; }

  try {
    let { id, result, total } = await runQuery(body, league);
    let relajada = false;
    let anchura = body.query.stats[0].filters.length;
    for (const n of attemptPlan(total, MODS_INICIALES)) {
      if (FIABLE.has(reliability(total))) break;
      const otro = buildRareQuery(item, index, helpers, n);
      if (!otro || otro.query.stats[0].filters.length === anchura) continue;
      anchura = otro.query.stats[0].filters.length;
      const intento = await runQuery(otro, league);
      if (isBetter(intento.total, total)) {
        relajada = true;
        body = otro;
        ({ id, result, total } = intento);
      }
    }
    const usado = body;
    const precios = total ? await fetchPrices(id, result, CHAOS_POR_DIV) : [];
    const mediana = precios.length ? precios[Math.floor(precios.length / 2)] : null;
    const fiabilidad = reliability(total);
    const cuenta = FIABLE.has(fiabilidad) && mediana;
    if (cuenta) { suma += mediana; tasados++; }

    console.log(
      `  ${cabecera.padEnd(42)} ${String(total).padStart(5)} res` +
      `  ≈ ${(mediana ? fmt(mediana) : '—').padStart(9)}` +
      `  fiab=${fiabilidad.padEnd(8)}${cuenta ? 'CUENTA' : 'descartado'}` +
      `${relajada ? ' (relajada)' : ''}`,
    );
    console.log(`      filtros: ${usado.query.stats[0].filters.map((f) => f.id).join(', ')}`);
  } catch (err) {
    console.log(`  ${cabecera}: ERROR ${err.message}`);
  }
}

console.log(`\nRaros con tasación fiable: ${tasados}/${rares.length}   suman ${fmt(suma)}`);
