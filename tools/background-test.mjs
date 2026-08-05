// Drives the real service worker over a whole character's worth of items.
//
// Every other test in here imports the library functions and calls them with
// arguments it built itself. That proves the libraries work; it proves nothing
// about background.js, which is the code that actually runs, and which has
// already shipped two bugs of exactly the shape a direct call cannot see: a
// helper left out of a call, and a parameter left out of a signature.
//
// So this one loads background.js unmodified, behind a mock `chrome`, and talks
// to it the only way content.js does — by posting messages.
//
//   node tools/background-test.mjs           # one item of each kind
//   node tools/background-test.mjs --all     # every item on the character
//   node tools/background-test.mjs Headhunter Watcher   # by name

import { readFileSync } from 'node:fs';

// ------------------------------------------------------------------ the mocks

const store = new Map();
const listeners = [];

globalThis.chrome = {
  runtime: {
    getManifest: () => JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')),
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener: (fn) => listeners.push(fn) },
  },
  // The real one rewrites User-Agent; here `fetch` is wrapped instead, below.
  declarativeNetRequest: { updateSessionRules: async () => {} },
  storage: {
    local: {
      async get(k) { return store.has(k) ? { [k]: store.get(k) } : {}; },
      async set(o) { for (const [k, v] of Object.entries(o)) store.set(k, v); },
      async clear() { store.clear(); },
    },
  },
};

const UA = 'poe-ninja-build-cost/0.4 (personal build pricing extension)';
const realFetch = globalThis.fetch;
let requests = 0;
globalThis.fetch = (url, init = {}) => {
  if (/pathofexile\.com\/api\/trade\/(search|fetch)/.test(String(url))) requests++;
  return realFetch(url, { ...init, headers: { ...(init.headers || {}), 'User-Agent': UA } });
};

await import('../src/background.js');

/** Post a message the way content.js does, and wait for the reply. */
function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    for (const fn of listeners) fn({ type, ...payload }, {}, done);
    // Generous: a single item can wait out a whole rate-limit window.
    setTimeout(() => reject(new Error(`no reply to ${type}`)), 600000).unref?.();
  });
}

// ------------------------------------------------------------------ the items

const { normalizeName } = await import('../src/lib/economy.js');

const raw = JSON.parse(readFileSync(new URL('fixtures/kinds.json', import.meta.url), 'utf8'));
const all = raw
  // Gems and flasks are priced from the economy index and never appraised, the
  // same filter content.js applies before it starts the trade pass.
  .filter((i) => i.frameType !== 4 && i.inventoryId !== 'Flask' && i.inventoryId);

const kind = (item) => item.kind || item.inventoryId;

const args = process.argv.slice(2);
let items;
if (args.includes('--all')) {
  items = all;
} else if (args.length) {
  const want = args.map((a) => a.toLowerCase());
  items = all.filter((i) => want.some((w) => `${i.name} ${i.baseType}`.toLowerCase().includes(w)));
} else {
  items = all;
}

// ------------------------------------------------------------------- the runs

const { leagues } = await send('leagues');
const league = leagues[0].id;
const { index, chaosPerDivine } = await send('prices', { leagueSlug: null });

const CHAOS_PER_DIV = chaosPerDivine || 187;
const fmt = (c) => (c == null ? '—'
  : c >= CHAOS_PER_DIV ? `${(c / CHAOS_PER_DIV).toFixed(1)} div` : `${Math.round(c)} c`);

console.log(`League ${league}   ${items.length} items\n`);

const failures = [];
for (const item of items) {
  const label = `${item.name || '(rare)'} ${item.baseType || item.typeLine}`.trim();
  const price = index[normalizeName(item.name || '')] || index[normalizeName(label)];
  const before = requests;

  let r;
  try {
    r = await send('appraise', {
      item,
      rollPool: price?.rollPool,
      implicitPool: price?.implicitPool,
      league,
      chaosPerDivine: CHAOS_PER_DIV,
      minRollPercent: 80,
      saleMode: 'available',
      matchCorruptedImplicits: true,
    });
  } catch (err) {
    r = { error: String(err.message) };
  }

  const head = `${kind(item).padEnd(16)} ${label.slice(0, 38).padEnd(38)}`;
  if (r.error) {
    console.log(`${head} ERROR  ${r.error}`);
    failures.push(`${label}: ${r.error}`);
  } else if (r.skipped) {
    // A unique with nothing rolled on it — a Tabula Rasa — has no combination to
    // search. The extension never gets here: it prices those from the economy
    // index. Skipping is the right answer, not a failure.
    const nothingToSearch = !(item.explicitMods || []).length
      && !(item.implicitMods || []).length;
    console.log(`${head} skipped: ${r.skipped}${nothingToSearch ? '  (expected — no mods)' : ''}`);
    if (!nothingToSearch) failures.push(`${label}: skipped — ${r.skipped}`);
  } else {
    const flags = [
      r.partial ? '>=' : '  ',
      r.reliable ? 'reliable' : 'UNRELIABLE',
      r.strategy || (r.variant ? 'variant' : ''),
    ].join(' ');
    console.log(`${head} ${fmt(r.chaos).padStart(8)}  ${String(r.total).padStart(5)} listings  ${flags}`);
    console.log(`${' '.repeat(16)} ${(r.filters || []).join(', ') || '(no filters)'}  [${requests - before} requests]`);
    if (!r.reliable) failures.push(`${label}: unreliable, ${r.total} listings`);
  }
}

console.log(`\n${requests} trade requests total`);
if (failures.length) {
  console.log(`\n${failures.length} item(s) did not price cleanly:`);
  for (const f of failures) console.log(`  ${f}`);
  process.exitCode = 1;
} else {
  console.log('every item priced');
}
