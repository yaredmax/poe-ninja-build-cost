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

const UA = 'poe-ninja-build-cost/0.5 (personal build pricing extension)';
const realFetch = globalThis.fetch;
let requests = 0;
globalThis.fetch = (url, init = {}) => {
  if (/pathofexile\.com\/api\/trade\/(search|fetch)/.test(String(url))) requests++;
  return realFetch(url, { ...init, headers: { ...(init.headers || {}), 'User-Agent': UA } });
};

await import('../src/background.js');

// Carry the rate-limit budget over from previous tool runs. Each process starts
// a fresh limiter that knows nothing until its first response, and a dozen of
// those in an afternoon is how you earn a 1800-second penalty on an IP that a
// person is also using to browse trade.
const { restoreLimits, trackLimits } = await import('./lib/shared-limits.mjs');
await trackLimits();
await restoreLimits();

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

const read = (name) => {
  const data = JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8'));
  return Array.isArray(data) ? data : data.items;
};

// Two fixtures, because one of them cannot do the job of the other. kinds.json
// is collected from trade listings, so on collection day every item in it
// matches its own widest query — the listing it came from is right there — and
// it drifts out of that as listings expire, which is a fixture that changes
// under you rather than one that tests the ladder. worn.json is items people
// are wearing, which nobody is selling, and those miss on purpose. The long
// version is in tools/fixtures/worn.json.
const raw = [...read('kinds.json'), ...read('worn.json')];
const all = raw
  // Gems only. Flasks used to be excluded here on the grounds that content.js
  // prices them from the economy index and never appraises them — which is
  // simply not true, and a real report showed two of them going to trade. The
  // filter meant every flask bug was invisible to this test, including an
  // enchantment that never reached the query.
  .filter((i) => i.frameType !== 4 && i.inventoryId);

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

// --------------------------------------------------------------- accounting
//
// The wide query — every modifier at once — costs one search and one fetch, and
// it is what nine items in ten spend. The fallback ladder below it is one query
// per subset per level, and that is where a slow pass goes. A total that adds
// the two together cannot tell you which one an "optimisation" moved, which is
// exactly how three of them were measured as free: the fixture had no item that
// missed the wide query, so the ladder never ran at all.

const PHASES = ['wide', 'fallback', 'broad'];
const zero = () => Object.fromEntries(PHASES.map((p) => [p, { searches: 0, fetches: 0 }]));
const totals = zero();
const outcome = { wide: 0, fallback: 0, broad: 0, none: 0, free: 0, cached: 0 };
const time = { total: 0, waiting: 0, network: 0 };

/**
 * Which half of the search produced the answer. `none` means it searched and
 * came back empty; `free` means it never asked, which is the right outcome for
 * a Tabula Rasa and a wrong one for anything else.
 */
function phaseOf(spend) {
  if (!spend) return 'none';
  for (const phase of ['broad', 'fallback', 'wide']) {
    if (spend[phase].fetches) return phase;
  }
  return PHASES.some((p) => spend[p].searches) ? 'none' : 'free';
}

function addSpend(spend) {
  if (!spend) return;
  for (const phase of PHASES) {
    totals[phase].searches += spend[phase].searches;
    totals[phase].fetches += spend[phase].fetches;
  }
  for (const key of Object.keys(time)) time[key] += spend.ms?.[key] ?? 0;
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

/** `wide 1s+1f  fallback 6s+1f  |  8 http  |  92.4s held, 1.9s on the wire` */
function spendLine(spend, http) {
  const parts = PHASES
    .filter((p) => spend?.[p].searches || spend?.[p].fetches)
    .map((p) => `${p} ${spend[p].searches}s+${spend[p].fetches}f`);
  const ms = spend?.ms;
  // Held by our own limiter versus in GGG's hands. Everything a slow pass could
  // be fixed by depends on which of the two it is.
  const time = ms ? `  |  ${seconds(ms.waiting)} held, ${seconds(ms.network)} on the wire` : '';
  return `${parts.join('  ') || 'no searches'}  |  ${http} http${time}`;
}

// Every badge is clickable, and the link is built without spending a request —
// so this covers all of them for free, and catches a query builder that throws
// or gives up on a kind of item the appraisal happens to price another way.
{
  const withIndex = items.map((item, i) => ({ ...item, index: i }));
  const { urls, error } = await send('links', {
    items: withIndex, league, minRollPercent: 80, saleMode: 'available',
  });
  if (error) {
    console.log(`links: ERROR ${error}\n`);
    failures.push(`links: ${error}`);
  } else {
    const missing = withIndex.filter((it) => !urls[it.index]);
    console.log(`links: ${Object.keys(urls).length}/${items.length} items got a trade link`);
    for (const it of missing) {
      console.log(`  no link: ${kind(it)} ${it.name || '(rare)'} ${it.baseType}`);
      failures.push(`${it.name || it.baseType}: no trade link`);
    }
    console.log('');
  }
}
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

  const head = `${kind(item).padEnd(20)} ${label.slice(0, 36).padEnd(36)}`;
  // Cached answers carry the spend of the run that produced them, and adding
  // that again would count the same searches twice. Two identical items in one
  // build is a saving, not a spend, so it is reported and not summed.
  if (r.cached) outcome.cached++;
  else { addSpend(r.spend); outcome[phaseOf(r.spend)]++; }
  const cost = r.cached ? 'cached (an identical item was already priced)'
    : spendLine(r.spend, requests - before);

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
    console.log(`${' '.repeat(20)} ${cost}`);
    if (!nothingToSearch) failures.push(`${label}: skipped — ${r.skipped}`);
  } else {
    const flags = [
      r.partial ? '>=' : '  ',
      r.reliable ? 'reliable' : 'UNRELIABLE',
      r.strategy || (r.variant ? 'variant' : ''),
    ].join(' ');
    console.log(`${head} ${fmt(r.chaos).padStart(8)}  ${String(r.total).padStart(5)} listings  ${flags}`);
    console.log(`${' '.repeat(20)} ${(r.filters || []).join(', ') || '(no filters)'}`);
    console.log(`${' '.repeat(20)} ${cost}`);
    if (!r.reliable) failures.push(`${label}: unreliable, ${r.total} listings`);
  }
}

// ------------------------------------------------------------------ the bill

const sum = (key) => PHASES.reduce((n, p) => n + totals[p][key], 0);

const row = (label, s, f) => `  ${String(label).padEnd(10)}${String(s).padStart(9)}${String(f).padStart(9)}`;
console.log(`\n${row('', 'searches', 'fetches')}`);
for (const phase of PHASES) {
  console.log(row(phase, totals[phase].searches, totals[phase].fetches));
}
console.log(row('total', sum('searches'), sum('fetches')));
console.log(`\n${requests} trade requests over the wire`);
// Which of GGG's rules were in force. A bare script gets `ip`; a client
// carrying the player's session also gets `account`, and the two do not
// publish the same numbers — so a run that does not say which it had cannot be
// compared with one that had the other.
{
  const { search, fetch } = await send('limits');
  for (const [name, side] of [['search', search], ['fetch', fetch]]) {
    for (const rule of side.rules || []) {
      console.log(`  ${name} ${rule.rule.padEnd(8)} ${rule.limit}`);
    }
  }
}
console.log(
  `${seconds(time.total)} appraising: ${seconds(time.waiting)} held by our own limiter, `
  + `${seconds(time.network)} waiting on GGG`,
);
// Fewer requests than searches means runQuery answered a repeat from its
// in-memory cache — two items that build the same query.
const asked = sum('searches') + sum('fetches');
if (requests < asked) console.log(`${asked - requests} answered from the query cache`);

const priced = outcome.wide + outcome.fallback + outcome.broad;
console.log(
  `\n${priced} item(s) priced: ${outcome.wide} on the wide query, `
  + `${outcome.fallback} down the fallback ladder, ${outcome.broad} on a broad search`,
);
if (outcome.none) console.log(`${outcome.none} searched and found nothing`);
if (outcome.free) console.log(`${outcome.free} needed no search at all`);
if (outcome.cached) console.log(`${outcome.cached} served from the appraisal cache`);
if (!outcome.fallback) {
  // The whole reason this accounting exists. See the README, "Two shortcuts
  // that cost more than they saved".
  console.log(
    '\nWARNING: no item exercised the fallback ladder, so this run says nothing\n'
    + '         about the slow path. Add an item that misses the wide query.',
  );
}
if (failures.length) {
  console.log(`\n${failures.length} item(s) did not price cleanly:`);
  for (const f of failures) console.log(`  ${f}`);
  process.exitCode = 1;
} else {
  console.log('every item priced');
}
