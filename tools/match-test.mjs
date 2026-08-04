// Exercises the fallback DOM matching against the real texts and icons scraped
// from a poe.ninja character page (tools/fixtures/character-page.json).
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

// same logic as src/content.js
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

const fmt = (c) =>
  c >= chaosPerDivine ? `${(c / chaosPerDivine).toFixed(1)} div` : `${Math.round(c)} c`;

console.log(`League: ${league}   1 div ~ ${Math.round(chaosPerDivine)} c\n`);

// Ad vendor names from the cookie dialog must NOT match. The extension scopes
// its scan to the <article>; here we assert the collision directly.
const VENDORS = new Set(page.texts.slice(page.texts.indexOf('Ad partners')));
const falsePositives = [...VENDORS].filter((t) => lookupText(t));
console.log(
  falsePositives.length
    ? `FALSE POSITIVES among ad vendors: ${falsePositives.join(', ')}\n`
    : 'OK: no ad vendor name matches an item\n',
);

console.log('--- BY TEXT ---');
let total = 0;
for (const text of page.texts) {
  const hit = lookupText(text);
  if (!hit) continue;
  const mark = hit.floor ? '>=' : hit.variantCount > 1 ? '+-' : '  ';
  total += hit.chaos || 0;
  console.log(`  ${mark} ${text.padEnd(38)} -> ${hit.name.padEnd(28)} ${fmt(hit.chaos).padStart(9)}`);
}

console.log('\n--- BY ICON ---');
for (const art of page.icons) {
  const key = icons[art];
  if (!key) continue;
  const hit = index[key];
  const mark = hit.floor ? '>=' : hit.variantCount > 1 ? '+-' : '  ';
  console.log(`  ${mark} ${art.padEnd(38)} -> ${hit.name.padEnd(28)} ${fmt(hit.chaos).padStart(9)}`);
}

console.log(`\nTotal by text: ${fmt(total)}`);
