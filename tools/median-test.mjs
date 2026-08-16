// How a handful of listings becomes the number on the badge.
//
//   node tools/median-test.mjs

import { medianPrice } from '../src/lib/trade.js';

let failures = 0;
const check = (got, want, label) => {
  const ok = got === want;
  console.log(`${ok ? '  ok   ' : '  FAIL '}${label}${ok ? '' : ` — got ${got}, want ${want}`}`);
  if (!ok) failures++;
};

const d = 193; // chaos per divine, only the ratios matter

// Demon Clutches: eight instant-buyout listings, cheapest 55d, next 124.4d.
// The badge used to quote the second seller. You would buy the first.
check(
  medianPrice([55, 124.4, 130, 140, 155, 170, 190, 220].map((n) => n * d), 8),
  55 * d,
  'eight listings: the cheapest real undercut, not the second seller',
);

check(
  medianPrice([1, ...[124.4, 130, 140, 155, 170, 190, 220].map((n) => n * d)], 8),
  124.4 * d,
  'eight listings: 1 c next to 124 divine is junk and is dropped',
);

check(
  medianPrice([250, 280, 285, 320, 320, 390, 4 * 35000].map((n) => n * d), 7),
  250 * d,
  'a mirror-priced listing is trimmed; the cheapest of the rest stays',
);

check(
  medianPrice([10, 12], 2),
  10,
  'two listings: the cheaper one',
);

check(
  medianPrice([10, 12, 14], 3),
  10,
  'three listings: still the cheapest',
);

// Ten cheapest of a much larger pool. Median of that tail, not the 1 c floor.
check(
  medianPrice([1, 1, 2, 3, 5, 8, 10, 12, 15, 20], 200),
  8,
  'wide search: median of the cheap tail, not the 1 c junk',
);

console.log(failures ? `\n${failures} case(s) wrong` : '\nall resolved');
process.exitCode = failures ? 1 : 0;
