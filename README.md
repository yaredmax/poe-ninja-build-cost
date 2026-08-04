# poe-ninja-build-cost

A Chrome extension (Manifest V3) that puts a price next to every item on a
[poe.ninja](https://poe.ninja/poe1/builds) character page and works out what the
build would cost.

## Install

1. `chrome://extensions` → turn on **Developer mode**.
2. **Load unpacked** → pick this folder.
3. Open any build: `https://poe.ninja/poe1/builds/.../character/...`
4. Panel on the top right → **Calculate cost**.

## Where the data comes from

**The character's items: by reading what's already in the page.** poe.ninja's
builds API is never called. Their [documentation](https://poe.ninja/docs/api) is
explicit:

> The builds / profiles API, and every other non-economy endpoint (character,
> Path of Building, authentication), are internal. They are undocumented,
> unsupported, and not available for third-party use.

Reading what the page has already painted adds zero requests to those endpoints,
and it respects players who hide their profile: if the site doesn't show it, the
extension doesn't see it either.

**Prices: the documented economy API**, which *is* public:

```
GET https://poe.ninja/poe1/api/economy/leagues
GET https://poe.ninja/poe1/api/economy/stash/current/item/overview?league={league}&type={type}
```

Thirteen categories are fetched (uniques, gems, cluster jewels…) at a maximum
concurrency of 3, cached locally for 10 minutes — PoE1 data refreshes about every
15 minutes, so asking more often gains nothing. The descriptive User-Agent the
docs ask for is injected with `declarativeNetRequest`, scoped to the service
worker's own requests (`tabIds: [-1]`) so the site's own traffic is untouched.

The header must be **ASCII**: with accented characters both poe.ninja and
Cloudflare answer 403.

## Primary path: `src/page-bridge.js`

poe.ninja keeps the full JSON of every item in React's memory, with the same
schema as GGG's official API: `explicitMods`, `craftedMods`, `sockets`, `ilvl`,
`corrupted`, `properties`. The test build yields 61 items, each with its slot
(`inventoryId`) and a DOM element to anchor a badge to.

This replaces DOM scanning, which is a hack by comparison: on that same build the
icon-based scan missed a Headhunter, a Skin of the Lords and a Ming's Heart —
most of the value. With the bridge the total went from **44.7 div to 135.9 div**.

It has to be a separate file because a normal content script lives in an isolated
realm and can't see `__reactFiber$…`. Still no extra requests to poe.ninja: this
is what the page already has loaded.

It is fragile by definition (minified React internals), so the text/icon scan
stays as an automatic fallback: if the bridge returns nothing, `content.js` drops
back to the old path and says so in the panel.

## How items are recognised (fallback path)

No poe.ninja CSS selectors are used: they're Astro-generated classes
(`_text_11d3e_1`) that change on every deploy. Two routes instead:

1. **By text**, against the ~2,400 names in the price index. Jewels appear as
   name + base ("Watcher's Eye Prismatic Jewel"), so the base suffix is stripped
   and retried.
2. **By icon**, for equipment: it carries no name in the DOM, only a poecdn
   `<img>`, and the economy API returns that same URL. Jewels and gems are
   excluded from this route because their art is the *base* art: a rare cluster
   jewel and the unique "The Light of Meaning" share `AfflictionJewel.png`.

Three details that cost blood and are covered by tests:

- The scan is scoped to the `<article>`. The footer carries the cookie dialog
  with hundreds of ad vendors, and some ("Impact", "Momentum", "Signal") collide
  with real item names.
- Forbidden jewels are published under the name of the *passive* they grant, so
  indexing them by name made the character's ascendancy list ("Deathmarked",
  "Mistwalker") get priced as if it were a jewel.
- The DPS block repeats skill names ("Blade Blast 2.2/s"), which double-counted
  every gem and read "2" as a gem level.

## What it can't do

This is an estimate with a floor, not a valuation:

- **Crafted rares are excluded from the base pass.** There is no "the price" of
  a pair of boots with life and resistances — that exact item is not for sale
  anywhere. See the appraisal section below.
- **Items marked `≥`** (Watcher's Eye, Sublime Vision, Impossible Escape,
  timeless jewels…): poe.ninja publishes a single price for all of them, and it's
  the cheapest one. The real one can be a hundred times higher. They're detected
  by counting `optional` modifiers (a normal unique has 0; a Watcher's Eye has
  87), plus a hand-written list for the ones that vary by something that isn't a
  mod. The trade pass prices these properly — see below.
- **Items marked `±`**: poe.ninja publishes several variants (gem level/quality,
  links, corruption) and the fallback path can't tell which one the character
  has. The best-selling one is shown.
- **Uniques marked "unpriced"**: poe.ninja doesn't publish them at all, usually
  because their value depends on something the economy doesn't break down. Skin
  of the Lords is the example: only "Skin of the Loyal" is listed, because the
  Lords version exists only corrupted and is worth whatever keystone it rolled.

That's why the total is labelled **Minimum**.

## Items priced by their own modifiers

Two kinds of item are searched for by the mods they actually carry, stepping
down 3 → 2 → 1 filters until the market has something. When it prices on fewer
mods than the item has, the badge shows `≥`: worth *at least* that.

**Rare jewels.** A jewel has no life, no resistances and no equipment category,
so the "similar gear" query below has nothing to work with. A jewel *is* its
three modifiers. Measured on a real build:

```
Luminous Creed  3 mods -> 0 listings   2 mods -> 17 listings   =>  1.0 div
Ghoul Sliver    3 mods -> 0 listings   2 mods -> 17 listings   =>  1.0 div
Dragon Sliver   3 mods -> 0 listings   2 mods -> 11 listings   =>  4.0 div
```

**Uniques marked `≥`**, by their roll — see below.

## Pricing `≥` uniques by their actual roll

poe.ninja publishes one price for every Watcher's Eye — the cheapest — so its
number is a floor. The trade pass searches for the item's *own* roll instead.

The trick is telling the rolled mods from the ones every copy carries. poe.ninja
flags the roll pool as `optional`, and that pool (87 modifiers for a Watcher's
Eye) travels in the price index. Without it we'd filter on the first three mods
listed — energy shield, life, mana — which every copy has, and land right back on
the floor price.

Asking for all rolled mods at once describes a nearly unique item, so the search
steps down 3 → 2 → 1 until the market has something. When it prices on fewer mods
than the item has, the badge shows `≥`: the item is worth *at least* that.

Measured on the test build's Watcher's Eye:

```
poe.ninja floor:  30 c
3 mods:  0 listings
2 mods:  0 listings
1 mod:  10 listings   median 2.0 div      ← 12x the floor
```

## Rare appraisal

A rare has no market price: that exact item isn't for sale. What we *can* do is
search for **similar items** and see what they go for. Hence the `≈` mark and the
wording in the panel.

How the search is built:

1. Each mod text is translated to its `stat id` via `/api/trade/data/stats`
   (`src/lib/stats.js`). Measured coverage: **56 of 57** mods on the test build.
2. The pseudo-mods people actually use are aggregated: total life and total
   elemental resistance, summing the combined and "all" variants.
3. Up to two more mods are added from a priority list (suppression, movement
   speed, crit multi, gem levels…). With five filters, all seven rares returned
   zero results.
4. The search is by **category**, not exact base: there is one "Focused Amulet"
   listed in the entire league, so any extra filter returns nothing.
5. The median of the cheapest listings is taken. The single cheapest listing on a
   wide search is always 1 c of junk.

### Reliability, and why half of it gets thrown away

The result count tells you how much to trust it. Two hundred helmets "with life
and resistances" at 1 c is not the helmet's price — it means the filters narrowed
nothing. One result is no better; it can be a made-up price.

| results | reliability | counts toward the total? |
| --- | --- | --- |
| 0 | none | no |
| 1–2 | thin | no |
| 3–40 | high | yes |
| 41–120 | medium | yes |
| >120 | low | no |

If the first attempt lands at zero or above a hundred and twenty, it retries with
one filter fewer or one more, up to twice, and only keeps the retry if it
improves.

**On the test build, 3 of 7 come out reliable.** That's low, and it's the honest
answer: the other four are shown with their estimate in amber, outside the total.
A confident wrong number would be worse than no number.

### Rate limiting

`src/lib/rate-limit.js` drives the pace from GGG's own response headers rather
than a fixed delay. Measured policies:

```
POST /api/trade/search   trade-search-request-limit
    5:10:60,  15:60:300,  30:300:1800,  600:21600:3600

GET  /api/trade/fetch    trade-fetch-request-limit
    12:4:10,  16:12:300,  50:300:300,   1000:21600:1800

GET  /api/trade/data/*   no limit headers at all (static data)
```

Each triplet is `hits:period:penalty`. **The penalty is deliberately ignored** —
it only applies if you exceed the limit, and the point is never to. Awakened PoE
Trade ignores it too; its parser reads only the first two fields.

One bucket per triplet, per policy. A request waits until every bucket for its
policy has room. Two details matter more than the arithmetic:

- **Start pessimistic.** Until the first response teaches us the real numbers we
  assume one request per 5 s.
- **Sync with `-state` on every response.** The buckets are per IP, so the trade
  website open in another tab spends the same budget. If the server's count is
  higher than ours, the difference is recorded as if we had spent it. A fixed
  delay is blind to this and would walk straight into a 429.

This is both faster and safer than the fixed 5 s gap it replaced: the seven-rare
pass went from about 70 s to **23.8 s**, and the limiter now knows about traffic
it didn't cause.

Cluster jewels are the only thing left out: they're worth the notables they
grant, and those aren't modifiers we can filter on. Ordinary rare jewels are
priced like uniques, by their own mods — see below.

## Where the price is painted

On equipment, jewels and flasks the badge is overlaid on the bottom right corner
of the icon, with `pointer-events: none` so it never covers poe.ninja's own item
tooltip. Gems are a text list, so there it sits next to the name. `placeBadge()`
decides based on the category and whether it finds an icon-sized container.

## Trade buttons (removed)

There used to be a ⇗ button per item that opened the search on the trade site. It
was pulled from the UI because it misbehaved.

`buildQuery()` and `search()` are still in `src/lib/trade.js`, marked as not
wired: both are tested and putting the button back is just calling them again.
The flow was `POST /api/trade/search/{league}` → `id` → open
`pathofexile.com/trade/search/{league}/{id}` via `chrome.tabs.create` from the
service worker (from the content script the `await` breaks the user-gesture chain
and Chrome blocks it as a popup).

## Tests

They hit the real APIs — there are no mocks, on purpose: every bug worth finding
here came from real data.

```bash
node tools/smoke-test.mjs   # pricing layer against the real API
```

```bash
node tools/match-test.mjs   # fallback matching against a real build's DOM
```

```bash
node tools/price-test.mjs   # prices for the 61 real items of a build
```

```bash
node tools/rare-test.mjs    # appraises 7 real rares against the trade API
```

If it ever stops recognising anything, from the page console:

```js
pncDiagnose()
```

dumps the candidate texts and icons so you can see what changed.

## Files

| File | What it does |
| --- | --- |
| `manifest.json` | MV3: permissions, content scripts, service worker |
| `src/background.js` | Service worker: messages, User-Agent, cache, appraisal |
| `src/content.js` | Panel, DOM scanning, badges, summary |
| `src/content.css` | Panel and badge styles |
| `src/page-bridge.js` | Pulls the item JSON out of the MAIN world |
| `src/lib/economy.js` | Economy API, price index, floor-price detection |
| `src/lib/trade.js` | Trade queries, rare appraisal, reliability |
| `src/lib/stats.js` | Mod text → `stat id`, pseudo-mods, roll pools |
| `src/lib/rate-limit.js` | Adaptive throttling from GGG's rate-limit headers |
| `tools/fixtures/` | Real texts, icons, items and mods from a character page |
