// Tattoos and runegrafts: are they published, and do the names join?
//
// They are bought like everything else and applied to the passive tree, so they
// never appear among a character's items and used to fall out of the total
// entirely. poe.ninja publishes them under the *exchange* endpoint, not the
// item one — `type=Tattoo` on the item overview is a 404, which is how they
// stayed missed.
//
// The join is the fragile part and the only thing worth guarding: `lines`
// prices an opaque id, `items` maps that id to a display name, and the
// character page writes a third string that has to match the second.
//
// Costs no trade searches.
//
//   node tools/tree-test.mjs

import { EXCHANGE_TYPES, normalizeName } from '../src/lib/economy.js';

const LEAGUE = 'Allflame';
const BASE = 'https://poe.ninja/poe1/api/economy/exchange/current/overview';
const UA = 'poe-ninja-build-cost/0.6.0 (+https://github.com/yaredmax/poe-ninja-build-cost)';

// Straight off the character in the report, read out of poe.ninja's own page
// data: `char.tattoos` and `char.runegrafts`, counted by name.
const CHARACTER = {
  'Tattoo of the Hinekora Warrior': 14,
  'Tattoo of the Rongokurai Warrior': 5,
  'Tattoo of the Ramako Scout': 1,
  'Tattoo of the Tasalio Tideshifter': 8,
  'Runegraft of the Fortress': 1,
  'Runegraft of the Sinistral': 1,
};

/** Mirror of `fetchExchange` in src/lib/economy.js. */
async function fetchExchange(type) {
  const url = `${BASE}?league=${encodeURIComponent(LEAGUE)}&type=${encodeURIComponent(type)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`poe.ninja ${res.status} for ${type}`);
  const data = await res.json();
  const nameById = new Map((data.items || []).map((entry) => [entry.id, entry.name]));

  const priced = [];
  for (const line of data.lines || []) {
    const name = nameById.get(line.id);
    if (name && line.primaryValue > 0) priced.push([name, line.primaryValue]);
  }
  return { priced, lines: (data.lines || []).length, items: (data.items || []).length };
}

let failures = 0;
const index = {};

for (const type of EXCHANGE_TYPES) {
  const { priced, lines, items } = await fetchExchange(type);
  for (const [name, chaos] of priced) index[normalizeName(name)] = { name, chaos };

  // A drop to zero means poe.ninja moved the endpoint or renamed the type, and
  // the failure would otherwise be silent: no prices, no error, no total.
  const ok = priced.length > 0;
  if (!ok) failures++;
  console.log(`${type.padEnd(12)}${String(lines).padStart(4)} lines`
    + `  ${String(items).padStart(4)} names  ->  ${String(priced.length).padStart(4)} priced`
    + `   ${ok ? 'OK' : 'NOTHING JOINED'}`);
}

console.log('\nThe character in the report:\n');

let total = 0;
let missing = 0;

for (const [name, quantity] of Object.entries(CHARACTER)) {
  const hit = index[normalizeName(name)];
  if (!hit) {
    missing++;
    console.log(`   x${String(quantity).padEnd(3)}${name.padEnd(38)}  NO PRICE`);
    continue;
  }
  total += hit.chaos * quantity;
  console.log(`   x${String(quantity).padEnd(3)}${name.padEnd(38)}`
    + `${hit.chaos.toFixed(1).padStart(9)} c  =  ${(hit.chaos * quantity).toFixed(0).padStart(6)} c`);
}

failures += missing;
console.log(`\n   ${Math.round(total)} c across 30 purchases, ${missing} without a price`);
console.log(failures ? `\n${failures} problem(s)` : '\nevery purchase priced');
// Set rather than `process.exit()`: forcing the exit while a socket from the
// last fetch is still closing trips a libuv assertion on Windows, which reports
// 127 over a run that passed.
process.exitCode = failures ? 1 : 0;
