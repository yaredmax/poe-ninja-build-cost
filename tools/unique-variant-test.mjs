// Which published line a unique gets, when links and corruption cannot tell.
//
// poe.ninja splits some uniques into lines that differ by one modifier, and the
// spread is not cosmetic: a four-flask Mageblood is 221 divine, a five-flask one
// 1426. Before `variantMods` the key was links, corruption and Foulborn
// mutation — none of which a belt has — so all four lines tied and the first won.
// poe.ninja sends them dearest first.
//
// Costs no trade searches: this is poe.ninja's economy API only.
//
//   node tools/unique-variant-test.mjs

import { variantMods, mutationKey } from '../src/lib/economy.js';
import { modTemplate } from '../src/lib/stats.js';

const LEAGUE = 'Allflame';
const BASE = 'https://poe.ninja/poe1/api/economy/stash/current/item/overview';
const UA = 'poe-ninja-build-cost/0.5.1 (+https://github.com/yaredmax/poe-ninja-build-cost)';

/** Mirror of `pncFixedModKey` in src/content.js. */
const fixedModKey = (text) => String(text).replace(/\s+/g, ' ').trim().toLowerCase();

/** Mirror of `variantByMods` in src/content.js. */
function variantByMods(lines, item) {
  const mods = item.explicitMods || [];
  const ownText = new Set(mods.map(fixedModKey));
  const ownTemplate = new Set(mods.map(modTemplate));
  let best = null;
  let bestScore = -1;
  let tied = false;

  for (const line of lines) {
    const { tpl = [], fixed = [] } = line[5] || {};
    if (tpl.some((mod) => !ownTemplate.has(mod))) continue;
    if (fixed.some((mod) => !ownText.has(mod))) continue;
    const score = tpl.length + fixed.length;
    if (score > bestScore) {
      best = line;
      bestScore = score;
      tied = false;
    } else if (score === bestScore) {
      tied = true;
    }
  }
  return tied ? null : best;
}

/** The tuples exactly as src/lib/economy.js builds them. */
function tuplesFor(lines) {
  return lines
    .filter((l) => typeof l.chaosValue === 'number')
    .map((l) => [
      l.links ?? 0,
      l.corrupted ? 1 : 0,
      l.chaosValue,
      mutationKey(l.mutatedModifiers),
      l.listingCount ?? 0,
      variantMods(l.explicitModifiers),
    ]);
}

/** What the old key did: first line whose links, corruption and mutation fit. */
function beforeFix(tuples, item) {
  const corrupted = item.corrupted ? 1 : 0;
  return tuples.find(([l, c, , k]) => l === item.links && c === corrupted && k === '')
    || tuples[0];
}

function afterFix(tuples, item) {
  const corrupted = item.corrupted ? 1 : 0;
  // Mirror of src/content.js: poe.ninja publishes 5, 6 or nothing, never 1-4.
  const links = item.links >= 5 ? item.links : 0;
  const keyed = tuples.filter(([l, c, , k]) => l === links && c === corrupted && k === '');
  const byMods = keyed.length > 1 ? variantByMods(keyed, item) : null;
  const settled = keyed.length === 1 ? keyed[0] : byMods;
  return { hit: settled || keyed[0] || tuples[0], settled: Boolean(settled) };
}

async function overview(type) {
  const url = `${BASE}?league=${encodeURIComponent(LEAGUE)}&type=${type}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`poe.ninja ${res.status} for ${type}`);
  return (await res.json()).lines || [];
}

// Two real items. The Mageblood is off the character in the bug report, the
// Ralakesh's out of tools/fixtures/worn.json — and it is a Frenzy one, which is
// the cheapest of its three lines while the one that used to win is the dearest.
const CASES = [
  {
    type: 'UniqueAccessory',
    name: 'Mageblood',
    expect: '4 Flasks',
    item: {
      name: 'Mageblood', links: 0, corrupted: false,
      explicitMods: [
        '+48 to Dexterity',
        '+21% to Fire Resistance',
        '+25% to Cold Resistance',
        'Magic Utility Flasks cannot be Used',
        'Leftmost 4 Magic Utility Flasks constantly apply their Flask Effects to you',
        'Magic Utility Flask Effects cannot be removed',
      ],
    },
  },
  {
    type: 'UniqueArmour',
    name: "Ralakesh's Impatience",
    expect: 'Frenzy',
    item: {
      name: "Ralakesh's Impatience", links: 4, corrupted: false,
      explicitMods: [
        '+21% to Cold Resistance',
        '+16% to Chaos Resistance',
        '18% increased Movement Speed',
        'Corrupted Blood cannot be inflicted on you',
        'Count as having maximum number of Frenzy Charges',
      ],
    },
  },
];

let failures = 0;

for (const test of CASES) {
  const lines = (await overview(test.type)).filter((l) => l.name === test.name);
  const tuples = tuplesFor(lines);
  const variantOf = (tuple) => lines.find((l) => l.chaosValue === tuple[2])?.variant ?? '?';

  const before = beforeFix(tuples, test.item);
  const { hit, settled } = afterFix(tuples, test.item);

  const ok = variantOf(hit) === test.expect;
  if (!ok || !settled) failures++;

  console.log(`\n${test.name}  —  ${lines.length} published lines`);
  for (const t of tuples) {
    console.log(`   ${variantOf(t).padEnd(10)} ${String(Math.round(t[2])).padStart(7)} c`
      + `  ${String(t[4]).padStart(5)} listings`
      + `   mods: ${t[5].tpl.length} template, ${t[5].fixed.length} fixed`);
  }
  console.log(`   before   ${variantOf(before).padEnd(10)} ${Math.round(before[2])} c`);
  console.log(`   after    ${variantOf(hit).padEnd(10)} ${Math.round(hit[2])} c`
    + `   exact: ${settled}`);
  console.log(`   expected ${test.expect}   ${ok && settled ? 'OK' : 'WRONG'}`);
}

// The wider class. These are every non-Foulborn unique poe.ninja splits into
// lines that share a link count, so before the fix each one handed some item
// the first line's price — and the first line is the dearest. We cannot check
// the pick without a real copy of each, but we can check the thing that makes
// the pick possible: that no two lines end up with the same key.
console.log('\nDo the published lines come out distinguishable?\n');

const SPREAD = [
  ['UniqueArmour', 'Bubonic Trail'],
  ['UniqueArmour', "Atziri's Splendour"],
  ['UniqueArmour', 'Shroud of the Lightless'],
  ['UniqueArmour', "Yriel's Fostering"],
  ['UniqueArmour', 'Lightpoacher'],
  ['UniqueArmour', 'Tombfist'],
  ['UniqueAccessory', 'Mageblood'],
];

for (const [type, name] of SPREAD) {
  const lines = (await overview(type)).filter((l) => l.name === name && l.links == null);
  const keys = lines.map((l) => {
    const v = variantMods(l.explicitModifiers);
    return JSON.stringify([v.tpl.slice().sort(), v.fixed.slice().sort()]);
  });
  const distinct = new Set(keys).size;
  // One line may legitimately publish nothing — poe.ninja does exactly that for
  // the five-flask Mageblood — and the scoring handles it. Two cannot be told
  // apart by anything.
  const blanks = keys.filter((k) => k === JSON.stringify([[], []])).length;
  const ok = distinct === lines.length && blanks <= 1;
  if (!ok) failures++;
  console.log(`   ${name.padEnd(26)}${String(lines.length).padStart(2)} lines`
    + `  ${String(distinct).padStart(2)} distinct  ${ok ? 'separable' : 'NOT SEPARABLE'}`);
}

console.log(failures ? `\n${failures} case(s) wrong` : '\nall resolved');
process.exit(failures ? 1 : 0);
