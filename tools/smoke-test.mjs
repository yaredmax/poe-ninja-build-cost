// Prueba el módulo de economía fuera de Chrome: stub mínimo de chrome.storage
// y llamada real a la API documentada de poe.ninja.
//
//   node tools/smoke-test.mjs

const store = new Map();
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        return store.has(key) ? { [key]: store.get(key) } : {};
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) store.set(k, v);
      },
    },
  },
};

const { buildPriceIndex, fetchLeagues, normalizeName } = await import('../src/lib/economy.js');

const leagues = await fetchLeagues();
console.log('Ligas:', leagues.map((l) => l.id).join(', '));

const league = leagues[0].id;
console.time('buildPriceIndex');
const { index, failed, chaosPerDivine } = await buildPriceIndex(league);
console.timeEnd('buildPriceIndex');

console.log(`Liga: ${league}`);
console.log(`Nombres indexados: ${Object.keys(index).length}`);
console.log(`1 div ≈ ${Math.round(chaosPerDivine)} c`);
if (failed.length) console.log('Categorías fallidas:', failed);

const muestra = [
  // precio fiable: mods fijos
  'Headhunter',
  'Tabula Rasa',
  "Kaom's Heart",
  // precio-suelo: depende de la tirada
  "Watcher's Eye",
  'Sublime Vision',
  'Impossible Escape',
  // varias variantes publicadas
  'Greater Multistrike Support',
  'Mageblood',
  // no debe existir: comprueba que no inventamos precios
  'Squire',
];

for (const nombre of muestra) {
  const hit = index[normalizeName(nombre)];
  const marca = hit ? (hit.floor ? '≥' : hit.variantCount > 1 ? '±' : ' ') : ' ';
  console.log(
    hit
      ? `  ${marca} ${nombre.padEnd(30)} ${String(Math.round(hit.chaos)).padStart(7)} c` +
          `  variantes=${hit.variantCount} listings=${hit.listings}`
      : `    ${nombre.padEnd(30)} (sin precio)`,
  );
}

const suelo = Object.values(index).filter((v) => v.floor).length;
console.log(`Entradas marcadas como precio-suelo: ${suelo}`);

const total = Object.values(index).reduce((n, v) => n + (v.chaos > 0 ? 1 : 0), 0);
console.log(`Entradas con precio > 0: ${total}`);
