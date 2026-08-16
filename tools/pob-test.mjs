// PoB paste pages hand us the character sheet's `char` object with the wrong
// slots, property lines stuffed into explicitMods, empty sockets, and gems
// that all share the skill name as an id. src/lib/pob-item.js turns that back
// into what the rest of the pipeline already prices.
//
// Cases are off https://poe.ninja/poe1/pob/973d3 (2026-08-14).
//
//   node tools/pob-test.mjs

import {
  stripPobHeaders,
  joinWrappedMods,
  linksFromSocketLine,
  defencesFromModLines,
  flaskBaseType,
  slotOf,
  stableId,
  withoutImplicitDupes,
  gemStatQueues,
  takeGemStats,
  gemImpliesCorruption,
} from '../src/lib/pob-item.js';
import { buildQuery } from '../src/lib/trade.js';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ok   ' : '  FAIL '}${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const body = {
  baseType: 'Twilight Regalia',
  inventoryId: 'BodyArmour',
  id: 'Energy Shield: 1023',
  explicitMods: [
    'Energy Shield: 1023',
    'Sockets: B-G-B-B-W-W',
    '118% increased Energy Shield',
    'Regenerate 155.9 Life per second',
    '+47% to Cold Resistance',
    '+1 to maximum number of Spectres',
  ],
  implicitMods: [
    '11% of Physical Damage from Hits taken as Chaos Damage',
  ],
};

check(
  JSON.stringify(stripPobHeaders(body.explicitMods))
    === JSON.stringify([
      '118% increased Energy Shield',
      'Regenerate 155.9 Life per second',
      '+47% to Cold Resistance',
      '+1 to maximum number of Spectres',
    ]),
  'PoB defence and socket lines leave the explicit mods',
);
check(linksFromSocketLine(body.explicitMods) === 6, 'Sockets: B-G-B-B-W-W is a 6-link');
check(defencesFromModLines(body.explicitMods).es === 1023, 'Energy Shield: 1023 is the defence total');
check(stableId(body) === null, 'a defence line is not a stable id');
check(slotOf(body) === 'BodyArmour', 'gear keeps its slot');

const flask = {
  name: '',
  baseType: "Masochist's Ruby Flask of the Cheetah",
  typeLine: "Masochist's Ruby Flask of the Cheetah",
  inventoryId: 'MainInventory',
};
check(slotOf(flask) === 'Flask', 'a magic flask in MainInventory is still a flask');
check(flaskBaseType(flask) === 'Ruby Flask', 'magic name yields the flask base');

const uniqueFlask = {
  name: "Rumi's Concoction",
  baseType: 'Granite Flask',
  typeLine: 'Granite Flask',
  inventoryId: 'MainInventory',
};
check(slotOf(uniqueFlask) === 'Flask', 'a unique flask in MainInventory is still a flask');
check(flaskBaseType(uniqueFlask) === 'Granite Flask', 'unique flasks keep their real base');

const jewel = {
  name: 'Cataclysm Hope',
  baseType: 'Large Cluster Jewel',
  typeLine: 'Large Cluster Jewel',
  inventoryId: 'MainInventory',
  id: 'Unique ID: f87bf560758058101d278e6ec5e9fd04514dc209b90a88059c741a5f9a30558b',
};
check(slotOf(jewel) === 'PassiveJewels', 'a cluster jewel in MainInventory is a jewel');
check(stableId(jewel) === jewel.id, 'Unique ID: … is stable');

const belt = {
  name: 'Darkness Enthroned',
  baseType: 'Stygian Vise',
  inventoryId: 'Belt',
  implicitMods: ['Has 1 Abyssal Socket'],
  explicitMods: [
    'Sockets: A A',
    'Has 1 Abyssal Socket',
    '98% increased Effect of Socketed Abyss Jewels',
  ],
};
check(linksFromSocketLine(belt.explicitMods) === 1, 'Sockets: A A is unlinked abyss sockets');
check(
  JSON.stringify(withoutImplicitDupes(stripPobHeaders(belt.explicitMods), belt.implicitMods))
    === JSON.stringify(['98% increased Effect of Socketed Abyss Jewels']),
  'PoB does not keep the implicit copied into explicits',
);

const watcher = {
  name: "Watcher's Eye",
  explicitMods: [
    'Limited to: 1',
    '6% increased maximum Energy Shield',
    '+873 to Armour while affected by Determination',
  ],
};
check(
  stripPobHeaders(watcher.explicitMods)[0] === '6% increased maximum Energy Shield',
  'Limited to: is not a modifier',
);

const timeless = {
  name: 'Elegant Hubris',
  explicitMods: [
    'Radius: Large',
    'Commissioned 159240 coins to commemorate Caspiro',
  ],
};
check(
  stripPobHeaders(timeless.explicitMods)[0].startsWith('Commissioned 159240'),
  'a timeless jewel keeps its seed line',
);

const queues = gemStatQueues([
  {
    allGems: [
      { name: 'Raise Spectre', level: 21, quality: 20, itemData: { baseType: 'Raise Spectre' } },
      { name: 'Raise Spectre', level: 20, quality: 0, itemData: { baseType: 'Raise Spectre' } },
      { name: 'Minion Damage Support', level: 21, quality: 20, itemData: { baseType: 'Minion Damage Support' } },
    ],
  },
]);
const first = takeGemStats(queues, { baseType: 'Raise Spectre', frameType: 4 });
const second = takeGemStats(queues, { baseType: 'Raise Spectre', frameType: 4 });
const support = takeGemStats(queues, { baseType: 'Minion Damage Support', frameType: 4 });
check(first.level === 21 && first.quality === 20, 'first Raise Spectre takes 21/20');
check(first.corrupted === true, '21/20 Raise Spectre is corrupted even when PoB omits the flag');
check(second.level === 20 && second.quality === 0, 'second Raise Spectre is a different copy');
check(second.corrupted === false, '20/0 Raise Spectre stays uncorrupted');
check(support.support === true, 'Minion Damage Support is a support gem');

const infer = [
  [{ name: 'Raise Spectre', level: 21, quality: 0 }, true, '21/0 is always corrupted'],
  [{ name: 'Raise Spectre', level: 21, quality: 23 }, true, '21/23 is always corrupted'],
  [{ name: 'Raise Spectre', level: 20, quality: 23 }, true, '20/23 is always corrupted'],
  [{ name: 'Raise Spectre', level: 20, quality: 20 }, false, '20/20 is not inferred'],
  [{ name: 'Raise Spectre', level: 20, quality: 20, corrupted: true }, true, 'an explicit flag still wins'],
  [{ name: 'Enlighten Support', level: 3, quality: 20 }, false, 'Enlighten 3 is the uncorrupted max'],
  [{ name: 'Enlighten Support', level: 4, quality: 0 }, true, 'Enlighten 4 is corrupted'],
  [{ name: 'Awakened Spell Echo Support', level: 5, quality: 20 }, false, 'Awakened 5 is the uncorrupted max'],
  [{ name: 'Awakened Spell Echo Support', level: 6, quality: 0 }, true, 'Awakened 6 is corrupted'],
  [{ name: 'Awakened Enlighten Support', level: 5, quality: 0 }, false, 'Awakened Enlighten 5 is not Empower-rules'],
  [{ name: 'Awakened Enlighten Support', level: 6, quality: 0 }, true, 'Awakened Enlighten 6 is corrupted'],
];
for (const [gem, want, label] of infer) {
  check(gemImpliesCorruption(gem) === want, label);
}

const spectreQuery = buildQuery({
  frameType: 4,
  baseType: 'Raise Spectre',
  gemLevel: 21,
  gemQuality: 0,
  corrupted: false,
});
check(
  spectreQuery?.query?.filters?.misc_filters?.filters?.corrupted?.option === 'true',
  'a 21 Raise Spectre trade search is Corrupted: Yes even when the flag is missing',
);
check(
  spectreQuery?.query?.filters?.misc_filters?.filters?.gem_level?.min === 21,
  'the same search still pins level 21',
);

const hex = { id: 'a'.repeat(32), baseType: 'Bone Ring' };
check(stableId(hex) === hex.id, 'a GGG hex id is still stable');

const escapeLines = [
  'Radius: Small',
  'Limited to: 1',
  'Passive Skills in Radius of Chaos Inoculation can be Allocated',
  'without being connected to your tree',
  'Passage',
];
check(
  joinWrappedMods(stripPobHeaders(escapeLines))[0]
    === 'Passive Skills in Radius of Chaos Inoculation can be Allocated without being connected to your tree Passage',
  'PoB wraps Impossible Escape into the one line trade indexes',
);
check(
  joinWrappedMods(stripPobHeaders(escapeLines)).length === 1,
  'the wrap does not leave Passage as its own modifier',
);

console.log(failures ? `\n${failures} case(s) wrong` : '\nall resolved');
process.exitCode = failures ? 1 : 0;
