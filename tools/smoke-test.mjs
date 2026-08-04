// Exercises the economy module outside Chrome: a minimal chrome.storage stub
// and a real call to poe.ninja's documented API.
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
console.log('Leagues:', leagues.map((l) => l.id).join(', '));

const league = leagues[0].id;
console.time('buildPriceIndex');
const { index, failed, chaosPerDivine } = await buildPriceIndex(league);
console.timeEnd('buildPriceIndex');

console.log(`League: ${league}`);
console.log(`Names indexed: ${Object.keys(index).length}`);
console.log(`1 div ~ ${Math.round(chaosPerDivine)} c`);
if (failed.length) console.log('Failed categories:', failed);

const sample = [
  // reliable: fixed mods
  'Headhunter',
  'Tabula Rasa',
  "Kaom's Heart",
  // floor priced: depends on the roll
  "Watcher's Eye",
  'Sublime Vision',
  'Impossible Escape',
  // several published variants
  'Greater Multistrike Support',
  'Mageblood',
  // must not exist: proves we don't invent prices
  'Squire',
];

for (const name of sample) {
  const hit = index[normalizeName(name)];
  const mark = hit ? (hit.floor ? '>=' : hit.variantCount > 1 ? '+-' : '  ') : '  ';
  console.log(
    hit
      ? `  ${mark} ${name.padEnd(30)} ${String(Math.round(hit.chaos)).padStart(7)} c` +
          `  variants=${hit.variantCount} listings=${hit.listings}`
      : `     ${name.padEnd(30)} (no price)`,
  );
}

const floors = Object.values(index).filter((v) => v.floor).length;
console.log(`Entries flagged as floor-priced: ${floors}`);
console.log(`Entries with a price > 0: ${Object.values(index).filter((v) => v.chaos > 0).length}`);
