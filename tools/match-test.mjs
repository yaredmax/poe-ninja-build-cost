// Prueba el matching contra los textos e iconos reales extraídos de una página
// de personaje de poe.ninja (tools/fixtures/character-page.json).
//
//   node tools/match-test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const store = new Map();
globalThis.chrome = {
  storage: {
    local: {
      async get(k) { return store.has(k) ? { [k]: store.get(k) } : {}; },
      async set(o) { for (const [k, v] of Object.entries(o)) store.set(k, v); },
    },
  },
};

const { buildPriceIndex, fetchLeagues, normalizeName } = await import('../src/lib/economy.js');
const page = JSON.parse(readFileSync(join(here, 'fixtures', 'character-page.json'), 'utf8'));

const league = (await fetchLeagues())[0].id;
const { index, icons, chaosPerDivine } = await buildPriceIndex(league);

// misma lógica que src/content.js
const BASE_SUFFIXES = /\b(jewel|flask|tincture|relic)$/i;
function lookupText(text) {
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

const fmt = (c) => (c >= chaosPerDivine ? `${(c / chaosPerDivine).toFixed(1)} div` : `${Math.round(c)} c`);

console.log(`Liga: ${league}   1 div ≈ ${Math.round(chaosPerDivine)} c\n`);

// Los nombres de vendors del diálogo de cookies NO deben casar: en la extensión
// el escaneo se acota al <article> del personaje, aquí lo comprobamos a mano.
const VENDORS = new Set(page.textos.slice(page.textos.indexOf('Ad partners')));
const falsosPositivos = [...VENDORS].filter((t) => lookupText(t));
console.log(
  falsosPositivos.length
    ? `⚠ FALSOS POSITIVOS entre vendors: ${falsosPositivos.join(', ')}\n`
    : '✓ ningún nombre de vendor casa con un ítem\n',
);

console.log('--- POR TEXTO ---');
let total = 0;
for (const text of page.textos) {
  const hit = lookupText(text);
  if (!hit) continue;
  const marca = hit.floor ? '≥' : hit.variantCount > 1 ? '±' : ' ';
  total += hit.chaos || 0;
  console.log(`  ${marca} ${text.padEnd(38)} -> ${hit.name.padEnd(28)} ${fmt(hit.chaos).padStart(9)}`);
}

console.log('\n--- POR ICONO ---');
for (const art of page.iconos) {
  const key = icons[art];
  if (!key) continue;
  const hit = index[key];
  const marca = hit.floor ? '≥' : hit.variantCount > 1 ? '±' : ' ';
  console.log(`  ${marca} ${art.padEnd(38)} -> ${hit.name.padEnd(28)} ${fmt(hit.chaos).padStart(9)}`);
}

console.log(`\nTotal por texto: ${fmt(total)}`);
