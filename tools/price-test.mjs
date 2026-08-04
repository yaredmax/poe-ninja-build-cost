// Prueba `priceForItem` con los ítems reales que el puente extrae de una build.
// El fixture salió de ejecutar la cosecha de src/page-bridge.js en
// poe1/builds/allflame/character/pathofky-0288/Ky_BladeBUSTIN.
//
//   node tools/price-test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const store = new Map();
globalThis.chrome = { storage: { local: {
  async get(k) { return store.has(k) ? { [k]: store.get(k) } : {}; },
  async set(o) { for (const [k, v] of Object.entries(o)) store.set(k, v); } } } };

const { buildPriceIndex, fetchLeagues, normalizeName } = await import('../src/lib/economy.js');
const { buildQuery } = await import('../src/lib/trade.js');
const items = JSON.parse(readFileSync(join(here, 'fixtures', 'character-items.json'), 'utf8')).items;

const league = (await fetchLeagues())[0].id;
const { index, chaosPerDivine } = await buildPriceIndex(league);

// espejo de priceForItem() en src/content.js
const ES_UNICO = (i) => i.frameType === 3 || i.frameType === 10;
const ES_GEMA = (i) => i.frameType === 4;

function priceForItem(item) {
  const entry = index[normalizeName(ES_GEMA(item) ? item.baseType : item.name)];
  if (!entry) return null;
  if (ES_GEMA(item) && entry.gems?.length) {
    const exacta = entry.gems.find(
      ([l, q, c]) => l === item.gemLevel && q === item.gemQuality && c === (item.corrupted ? 1 : 0));
    const porNivel = entry.gems.filter(([l]) => l === item.gemLevel);
    const hit = exacta || porNivel[0];
    if (hit) return { ...entry, chaos: hit[3], detalle: `${item.gemLevel}/${item.gemQuality}` };
    return entry;
  }
  if (ES_UNICO(item) && entry.uniq?.length) {
    const corrupto = item.corrupted ? 1 : 0;
    const exacta = entry.uniq.find(([l, c]) => l === item.links && c === corrupto);
    const porLinks = entry.uniq.filter(([l]) => l === item.links);
    const hit = exacta || porLinks[0];
    if (hit) return { ...entry, chaos: hit[2], detalle: item.links >= 5 ? `${item.links}L` : null };
  }
  return entry;
}

const fmt = (c) => (c >= chaosPerDivine ? `${(c / chaosPerDivine).toFixed(1)} div` : `${Math.round(c)} c`);
const etiqueta = (i) => i.name || i.baseType;

console.log(`Liga: ${league}   1 div ≈ ${Math.round(chaosPerDivine)} c   ítems: ${items.length}\n`);

let total = 0;
const sinPrecio = [];
const filas = [];
for (const item of items) {
  const p = priceForItem(item);
  if (!p) { sinPrecio.push(item); continue; }
  total += p.chaos || 0;
  filas.push({ item, p });
}

// espejo de categoriaDe() en src/content.js
const HUECOS_EQUIPO = new Set(['Helm', 'BodyArmour', 'Boots', 'Gloves', 'Weapon',
  'Weapon2', 'Offhand', 'Ring', 'Ring2', 'Amulet', 'Belt']);
function categoriaDe(item) {
  if (ES_GEMA(item)) return 'Gemas';
  if (item.inventoryId === 'Flask') return 'Flasks';
  if (item.inventoryId === 'PassiveJewels') return 'Joyas';
  if (HUECOS_EQUIPO.has(item.inventoryId)) return 'Equipamiento';
  return 'Otros';
}

console.log(`TOTAL: ${fmt(total)}  (${filas.length} con precio, ${sinPrecio.length} sin precio)\n`);

const grupos = new Map();
for (const f of filas) {
  const c = categoriaDe(f.item);
  if (!grupos.has(c)) grupos.set(c, []);
  grupos.get(c).push(f);
}
const secciones = [...grupos.entries()]
  .map(([nombre, items]) => {
    // mismo colapso de repetidos que el panel
    const repes = new Map();
    for (const { item, p } of items) {
      const det = p.detalle ? ` (${p.detalle})` : '';
      const clave = `${etiqueta(item)}${det}|${p.floor}|${p.chaos}`;
      const previo = repes.get(clave);
      if (previo) { previo.cantidad++; previo.chaos += p.chaos; }
      else repes.set(clave, { nombre: etiqueta(item) + det, floor: p.floor, chaos: p.chaos, cantidad: 1 });
    }
    const filas = [...repes.values()].sort((a, b) => b.chaos - a.chaos);
    return {
      nombre, filas,
      unidades: filas.reduce((s, f) => s + f.cantidad, 0),
      subtotal: filas.reduce((s, f) => s + f.chaos, 0),
    };
  })
  .sort((a, b) => b.subtotal - a.subtotal);

for (const s of secciones) {
  console.log(`${s.nombre.toUpperCase()} (${s.unidades})`.padEnd(44) + fmt(s.subtotal).padStart(10));
  for (const f of s.filas) {
    const etiq = f.nombre + (f.cantidad > 1 ? ` x${f.cantidad}` : '');
    console.log(`  ${f.floor ? '≥' : ' '} ${etiq.padEnd(38)} ${fmt(f.chaos).padStart(10)}`);
  }
  console.log('');
}
// Igual que el panel: un único sin precio no es lo mismo que un raro.
const noCotizados = sinPrecio.filter((i) => ES_UNICO(i));
const aleatorios = sinPrecio.filter((i) => !ES_UNICO(i));

console.log(`SIN COTIZAR (${noCotizados.length})`.padEnd(44) + '—'.padStart(10));
for (const i of noCotizados) console.log(`    ${etiqueta(i)} [${i.baseType}]`);

console.log(`\nRaros/mágicos sin precio (${aleatorios.length}):`);
for (const i of aleatorios) console.log(`    ${etiqueta(i)} [${i.baseType}]`);

// El botón de trade sólo debe salir donde poe.ninja no pone el suyo.
const conBoton = items.filter(
  (i) => i.inventoryId !== 'PassiveJewels' && (ES_GEMA(i) || ES_UNICO(i)) && buildQuery(i));
console.log(`\nBotones de trade: ${conBoton.length}`);
console.log('  ejemplo query:', JSON.stringify(buildQuery(items.find((i) => i.name === 'Headhunter'))));
const jewelsConBoton = conBoton.filter((i) => i.inventoryId === 'PassiveJewels');
console.log(jewelsConBoton.length ? `  ⚠ duplicando en joyas: ${jewelsConBoton.length}` : '  ✓ ninguna joya duplicada');
