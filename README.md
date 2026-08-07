# poe-ninja-build-cost

A Chrome extension (Manifest V3) that puts a price next to every item on a
[poe.ninja](https://poe.ninja/poe1/builds) character page and works out what the
build would cost.

## Install

1. `chrome://extensions` → turn on **Developer mode**.
2. **Load unpacked** → pick this folder.
3. Open any build: `https://poe.ninja/poe1/builds/.../character/...`
4. Click the button in the bottom right corner.

That one button does everything: poe.ninja's economy prices land immediately,
then the trade pass runs behind them and the panel updates item by item.

Clicking the button again folds the panel into a pill that keeps the running
total in the corner of your eye, so you can read the passive tree while the pass
finishes; clicking the pill opens it back up. That button is the only thing that
opens and folds the panel. **Clear prices**, in the panel's footer, is the real
exit — it stops the pass, takes the badges off the page and puts the button back
where it started.

## Support

Found a bug, or something priced wrong?
[Open an issue](https://github.com/yaredmax/poe-ninja-build-cost/issues/new).
The most useful report is the build URL and which item looked wrong — the panel
links every price to the exact trade search behind it, so that link tells me
almost everything.

<a name="support"></a>
If this saved you time and you feel like buying me a coffee, thank you — but the
extension is free and will stay that way.

<a href="https://ko-fi.com/yaredmax/?hidefeed=true&amp;widget=true&amp;embed=true&amp;preview=true"><img src="https://storage.ko-fi.com/cdn/kofi6.png?v=6" alt="Buy Me a Coffee at ko-fi.com" height="36"></a>

## Options

The toolbar icon opens a popup with the two settings that get revisited, a way
through to the rest, and the same status line the panel shows — so "is it still
working?" is answerable without switching back to the tab. Changing a setting
during a run says **applies to the next run**: a four-minute pass is never
restarted behind your back.

The full page is at `chrome://extensions` → Details → Extension options. All of
it is explained on the page itself:

- **Minimum roll** (default 80%) — how good a listing has to be to count as
  comparable. Ignored for uniques, whose ranges are narrow, except timeless and
  Time-Lost jewels.
- **Which listings count** (default "Instant Buyout") — the same choice as the
  trade site's own dropdown. An "In Person" listing is a message to a player who
  may never answer, so its asking price is softer and less of a real price.
- **Corrupted uniques** (default on) — match the implicit a corruption added. A
  Le Heup of All with "+1 to Maximum Power Charges" is worth many times a plain
  one. Turn it off if a corrupted unique finds nothing.
- **Clear cached prices** — appraisals are kept for two hours, keyed on what the
  item *is* rather than which copy it is: two identical jewels are one lookup,
  and so is the same item met again on another character.

They live in `chrome.storage.sync`, so they follow you between machines, and the
content script re-reads them at the start of every run.

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

One more endpoint, for what the listings are quoted in:

```
GET https://poe.ninja/poe1/api/economy/stash/current/currency/overview?league={league}&type=Currency
```

Sellers price in whatever they like, and on cheap gear it is almost never chaos:
the ten cheapest rare belts in the league are all "1 alch". Only chaos and divine
used to be understood, so items with **thousands of listings came back with no
price at all**. Neither side has the whole answer — trade quotes a short id and
only its `/data/static` says `alch` means "Orb of Alchemy", while poe.ninja knows
what an Orb of Alchemy is worth — so the two are joined on the display name. That
covers all 69 currencies instead of the two that happened to be hard-coded.

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

Every item that isn't priced by name is searched for by the mods it actually
carries: all of them, then every combination of one fewer, until the market has
something. When it prices on fewer mods than the item has, the badge shows `≥`:
worth *at least* that.

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
steps down: all of them, then **every combination** of one fewer, then of two
fewer, stopping at the first level where the market has anything.

That step-down is only allowed for the modifiers that actually vary between
copies: the corruption implicits, the Foulborn mutation, and the rolled ones —
**rolled meaning in poe.ninja's published pool**, which is the only thing that
tells a rolled modifier from a fixed one. Leaving that last clause out cost the
feature its own flagship item for a day: an uncorrupted Watcher's Eye had
nothing it was willing to ladder, so its three-modifier query missed and it fell
through to "any Watcher's Eye at all" — 10000 listings, median **2 c**, for a
jewel the ladder then priced at **16.3 div**.

At that level every combination that returned listings is priced, and the
**dearest** one wins. That is the point of the exhaustive search: the item
carries all of the modifiers, so it is worth at least as much as the priciest
subset somebody is actually selling. Any one subset is a lower bound; the
highest of them is the tightest one available. The badge shows `≥` to say so.

With three modifiers that is 1 + 3 + 3 = 7 searches worst case, capped at 8.
Most items stop at the first or second.

Numeric values are left out of the filters. For most uniques the roll range is
narrow enough that a minimum only costs listings. Timeless and Time-Lost jewels
are the exception — there the number *is* the item — and they're listed in
`VALUE_SENSITIVE`.

Measured on the test build's Watcher's Eye:

```
poe.ninja floor:  30 c
3 mods           0 listings
2 mods (3 pairs) 0,  0,  0
1 mod  (3 alone) 32, 52, 40   -> priced all three, dearest wins

=> 2.0 div        12x the floor, in 7 searches
```

The number happens to match what the old "first single mod" descent found. What
changed is that it is now justified: we know every pair has no market, so no
tighter bound exists. On an item where a different pair or single is the
valuable one, the old approach would have missed it.

## What each kind of item is searched by

| Kind | Query |
| --- | --- |
| Unique, gem | Name and base type |
| Unique whose roll matters | Name plus the modifiers it rolled, by combination |
| Corrupted unique | The above plus the implicit the corruption added |
| Foulborn | The above plus `misc_filters.mutated`, which trade labels "Foulborn" |
| Rare gear | All its modifiers by combination, across the category, plus property totals |
| Rare jewel | Its own modifiers, by base type |
| Cluster jewel | The notables it grants, then the passive count |
| Rare weapon | The above plus dps, pdps, edps, attack rate and crit |

Two things never take a filter slot, because something else already expresses
them: resistances become one pseudo total each, elemental and chaos, and any
modifier feeding a property — energy shield, armour, evasion, ward, block,
damage — is covered by that property's own filter. A hybrid roll counts fully
toward both of its halves; before the chaos pseudo existed, "+13% to Fire and
Chaos Resistances" was dropped as a resistance mod and then counted for nothing,
because the elemental total requires both halves to be elemental.

Strength feeds the life pseudo at half a life per point, and like Awakened we
only build that pseudo when the item has a flat life modifier: an amulet with
Strength and no life is not a life amulet.

A modifier is also searched **where it actually sits on the item**. Only
`fractured` and `crafted` are rewritten to their explicit twin, because those
describe how a modifier arrived rather than what it is. Everything else keeps
its own prefix, and two bugs paid for that rule: a cluster jewel's "Adds 5
Passive Skills" matches the market as `enchant.` and nothing at all as
`explicit.`, and a corrupted Le Heup's "Bleeding cannot be inflicted on you" is
an `implicit.` that no copy carries as an explicit — so the search found
nothing, fell back to two common mods, and returned the 1 c floor of the
commonest ring in the game.

## Which uniques get searched

Most do not. poe.ninja's published price *is* the answer for an ordinary unique,
and searching all thirty in a build would multiply the pass for nothing. Four
kinds differ from the copy they priced:

| kind | why |
| --- | --- |
| optional modifiers, or the `floor` flag | they publish one price for every roll, and it is the cheapest |
| several published variants (`±`) | Ralakesh's Impatience granting Power Charges is worth many times the Frenzy one |
| Foulborn | not the unique it is named after |
| a corruption that *added* an implicit | corrupted alone is not enough; the extra implicit is what moves the price |
| no published price at all | including a name whose base does not match — see Stormblood below |

The corrupted case has to compare implicit *texts* against poe.ninja's published
pool, not count them. Counting was wrong on the item it most needed to be right
about: they publish one implicit for Le Heup of All, the Iron Ring's "Adds # to
# Physical Damage to Attacks", and a corrupted copy carries one implicit too —
the corruption's. One is not more than one, so the ring never reached trade and
kept the plain unique's 7 c instead of the 9 div it was worth.

**A unique is its name and its base.** Two can share a name: poe.ninja publishes
"Stormblood" only as a Sapphire Flask, at 20 c, and matching on the name alone
handed that price to a Stormblood Topaz Flask, which is a different item they do
not price at all. When the base does not match we admit we have no number and
let the trade pass find one.

## Rare appraisal

A rare has no market price: that exact item isn't for sale. What we *can* do is
search for items like it and see what they go for. Two strategies are tried, in
this order:

**1. All of its modifiers, then every combination of one fewer**, across its
equipment category — the same search the uniques get. This catches what no
hand-written list ever will: the test build's Focused Amulet is defined by
"+2 to Level of all Physical Skill Gems", a mod the priority list below doesn't
know about, and pricing it any other way lands on junk.

It used to take the first three modifiers in the order poe.ninja listed them,
which is how a Void Sceptre got priced on fire damage, cast speed and crit while
"+20% to Fire Damage over Time Multiplier" — the mod a fire build actually pays
for — never reached the query, purely because it was listed last. Measured over
one real item of each kind:

```
helm          50 c /   10 listings  ->   20 c /   1   (7 filters)
body armour    5 c /  143           ->   45 c /  13
boots          1 c /  389           ->   20 c /   1
gloves         5 c / 1684 unreliable->   10 c / 117 reliable
ring           1 c /  173           ->  100 c /   4
belt           1 c / 2921           ->    5 c / 196

48 trade requests -> 36
```

Fewer requests, not more, which is the opposite of what you'd expect. Pinning
every modifier usually hits on the first query; stepping 3 → 2 spent a request
per level to arrive somewhere worse. Those items were sampled above 20 c, so the
1 c answers were simply wrong.

What makes it affordable is the **weapon and armour properties** — the same
boxes Awakened PoE Trade shows: `dps`, `pdps`, `edps`, `aps`, `crit`, and
`ar` / `ev` / `es` / `ward` / `block`. Added damage, increased physical damage,
attack speed and crit are all expressed by those, so they cost no filter slot
and the combinations start from a much shorter list.

### Two shortcuts that cost more than they saved

The wide query hits on nine items in ten, at one search and one fetch. When it
misses, the fallback is where the time goes: dropping one modifier from six is
six queries, one per modifier. Both attempts to make that cheaper were measured
and both were reverted, so here is why, to save the next attempt.

A full `background-test.mjs` run, 23 items, five of which miss:

```
             searches  fetches
  wide             22       17
  fallback         23       10
  broad             1        1
  total            46       28

74 trade requests over the wire
22 item(s) priced: 17 on the wide query, 4 down the ladder, 1 on a broad search
```

Five items out of twenty-three account for half of every search made. That is the
number a future attempt has to move, and it is the one the suite could not
produce before: it reported "36 trade requests total", with the ladder's share of
that sitting at zero.

**Descending instead of permuting** — keep the most important N, drop the tail —
looks strictly better: same query count, more modifiers pinned. But the order
`rolledMods` returns is field order, not what the market pays for, so the tail it
drops is not the cheap part.

```
gloves, permuting     4 filters   130 listings   10 c
gloves, descending    2 filters  4267 listings    1 c
```

**Narrowing the wide query** from six modifiers to five caps the worst case at
six searches instead of seven. But the wide query is the one that *hits*, so a
filter comes off nine items to save a query on the tenth.

```
cluster jewel, six filters   3 listings   56 c
cluster jewel, five filters 25 listings   40 c
pass total: 36 requests either way
```

**A `count` stat group** is the operation the ladder emulates by hand, and trade
supports it. At full minimum it is exactly equivalent. One level down it pools
every subset into one result set, and since we take the ten cheapest, they all
come from whichever subset is junk:

```
and, all 4          15 listings   median 100 c
count min 4 of 4    15 listings   median 100 c
count min 3 of 4  1745 listings   median   1 c
```

Separating the subsets is the entire point of the ladder.

**2. Pseudo life and resistances plus one priority mod.** Deliberately broad —
step 1 already tried the specific route. This is the better answer for plain
defensive gear whose individual mods are all common.

A search built from the item's own mods is precise, so a single listing is a
real answer — "one like yours is on sale for X" — and is accepted. The
"too few results" gate below only guards the lookalike search, where one result
can be a fluke. Since we always filter on a subset of the mods, these are floors
and show `≥`.

How the lookalike search is built:

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
than a fixed delay. **There is no single policy to write down here**, and that is
not a documentation gap — GGG's own docs say so:

> Common rules are: ip, account, and client.

Several rules apply to one request, each with its own numbers, and which ones you
get depends on the caller. Two observations of the same endpoint, in the same
league, minutes apart:

```
POST /api/trade/search    trade-search-request-limit

  rule ip        5:10:60,  15:60:300,  30:300:1800,  600:21600:3600
  ip + account   3:5,  8:10,  15:60,  60:300,  600:10800
```

The second is the extension running in a browser that is signed in to
pathofexile.com; the first is a bare script that is not. Signing in **doubles the
sustained budget** — 60 per 300 s against 30 — at the cost of a stricter opening
burst. So the fast path is the logged-in one, which is the opposite of the folk
wisdom, and neither number is safe to hard-code.

```
GET  /api/trade/fetch     trade-fetch-request-limit
GET  /api/trade/data/*    no limit headers at all (static data)
```

Each triplet is `hits:period:penalty`. **The penalty is deliberately ignored** —
it only applies if you exceed the limit, and the point is never to. Awakened PoE
Trade ignores it too; its parser reads only the first two fields.

Every bucket remembers which rule it came from. Two rules can publish the same
shape — both had a 15-per-60 s one — and without the rule as part of a bucket's
identity they collapse into one object that then sits twice in the array and is
charged twice for a single request. `pncReport()` prints the rules verbatim, so
a slow pass can be explained rather than guessed at.

One bucket per triplet, per policy. A request waits until every bucket for its
policy has room. Two details matter more than the arithmetic:

- **Start pessimistic.** Until the first response teaches us the real numbers we
  assume one request per 5 s.
- **Leave a sixth of every bucket alone.** The buckets are per IP, so a pass and
  the player's own trade tab spend the same allowance, and filling it hands them
  the 429. It used to be a third; simulated over the real policies for the 46
  searches a measured pass sends, a third costs 10:13 and a sixth 6:24, while
  giving the whole bucket away saves only twenty seconds more than that. Past
  the opening burst the pace is set by the 300 s bucket, where 25 usable and 29
  are much the same.
- **Sync with `-state` on every response.** The buckets are per IP, so the trade
  website open in another tab spends the same budget. If the server's count is
  higher than ours, the difference is recorded as if we had spent it. A fixed
  delay is blind to this and would walk straight into a 429.

This is both faster and safer than the fixed 5 s gap it replaced: the seven-rare
pass went from about 70 s to **23.8 s**, and the limiter now knows about traffic
it didn't cause.

**What it cannot do is beat the policy.** 30 searches per 300 s is one search
every 10 s sustained, and reserving a sixth for the player makes it 12. No
client is faster than that — Awakened PoE Trade spends one search per item and
checks one item at a time, which is why it never feels slow; a whole build at
once is a different shape of problem. The only real lever is asking fewer
questions per item, which is why the ladder is worth measuring.

Measured on a real build, 30 items, from `pncReport()`:

```
wall     386.9 s
waiting  361.2 s   93.4%   our own limiter
network   25.4 s    6.6%   GGG
```

So there is nothing to win in the network and everything to win in the number
of questions. 69 searches for 30 items is not GGG being slow; it is us asking
three times per item.

Cluster jewels are the only thing left out: they're worth the notables they
grant, and those aren't modifiers we can filter on. Ordinary rare jewels are
priced like uniques, by their own mods — see below.

## What the colours mean

Colour says how far to trust the number, not where it came from:

| | | counts toward the total? |
| --- | --- | --- |
| **solid amber** | a firm number | yes |
| **hollow amber** | a floor — `≥` or `±` | yes, as a minimum |
| **grey** | `?`, or no price at all | no |
| *pulsing* | still queued for trade; what you see is provisional | — |

The symbol says why: `≈` priced on everything the item has, `≥` on fewer
modifiers than it has, `±` poe.ninja publishes several variants and we could not
tell which one this is, `?` too many lookalikes to mean anything.

They used to encode the *source* — economy or trade — in two ambers twelve
percent apart in lightness, which on a ten-pixel badge is one colour and needed
explaining every time. A trade appraisal that pinned every modifier is as firm as
a published price, so it gets the same solid amber now.

That solid amber carries **dark** text, which is the one thing that reads over a
stack of loot art: amber-on-dark disappeared against a bright unique. The hollow
badge keeps a dark fill so its outline stays visible either way.

The full reason behind each number — the listing count, which modifiers went into
the search, the confidence, what it cost — is in the panel, on the (i) at the end
of each row. It has to be there rather than on the badge, because the badge
cannot take the mouse without hiding poe.ninja's tooltip.

## Clicking a price

Every appraised badge remembers the id of the search that produced its number
and opens exactly that search on the trade site. GGG's search ids are durable,
so you see the very listings the median came from — not a fresh query that might
disagree with what's on screen. Summary rows link the same way.

Corner badges are `pointer-events: none` so they don't cover poe.ninja's item
tooltip; a clickable one opts back in, which costs the tooltip on that corner.

## The floating button's radius, and why it is not 50%

It used to flutter open and shut when the pointer sat near its bottom edge. The
cause is worth writing down because it looks like a hover bug and is not:
`border-radius: 50%` is not "a circle", it is half of each axis independently.
On the 48px resting button that *is* a circle; while hover animates the width to
120px it is an **ellipse**, whose bottom pinches to a single point at the
centre. A cursor two pixels above the bottom edge is inside the circle and
outside the ellipse, so hover dropped, the button shrank, the cursor was inside
again, and it looped until you moved the mouse.

`border-radius: 24px` draws the identical circle at 48px and stays a stadium at
every width. Checked at 48, 80, 120 and 160px: the point stays inside at all of
them, where `50%` puts it outside at the three larger ones. On top of that the
button carries an 8px invisible halo (`#pnc-fab::before`), which also covers the
resting circle's own corners, and the label animates on `max-width`/`opacity`
instead of switching `display`, so folding back up is the same movement as
opening. The progress ring gets a fixed `29px` for the same reason — it was 50%
of a 58px box, the same trap one layer out.

## Where the price is painted

On equipment, jewels and flasks the badge sits *outside* the bottom right corner
of the icon — 4px right, 7px down — so none of the item art is covered and it
never collides with the socket dots. `pointer-events: none`, so poe.ninja's own
item tooltip still opens.

Gems are a text list, and there the price goes straight after the name with 6px
of air, sized to its contents. The design wanted a scannable column of prices
down the right of the card and it was built that way twice. Appending to the
widest flex ancestor swept every price in the card into a single strip.
Identifying the gem's own row and appending there put the price on a line of its
own *underneath* the name — which is the worst of the three, because a number on
its own line belongs equally to the gem above and the gem below, and you end up
counting rows to find out which.

Measured on a live character before settling on it: sixteen of seventeen gems
keep the badge on the name's line, with at least 103px still spare in the cell.
The seventeenth is the copy the DPS block makes of the main skill, which the
scanner already suppresses. The column only pays when the rows are uniform, and
poe.ninja's are not.

A gem's badge carries no qualifier. It used to show level and quality, which
poe.ninja has already printed in the same row a centimetre to the left. `6L` on
a weapon has no twin on the page and stays.

`placeBadge()` decides between the two by category and by whether it finds an
icon-sized container.

**A badge is as small as its number, and the number shrinks to fit the tile.**
One common width was tried first — 65px in the grid, 58px on a small tile — so
the prices would form a column. It works when every tile is the same size, and
poe.ninja's are not: a helmet is 98px and a ring 36px, so a single width leaves
`10c` marooned in a slab of padding on the big tiles and hangs off both sides of
the small ones, both on the same screen.

So `fitBadge()` scales the *text* instead — never up, never below 8.5px. On a
live character page: 78px tiles never shrink at all (badges 29–58px, inside the
tile); on a 36px ring the short values are untouched and `≈ 152.3d` drops from
11.5px to 8.5px, 58px wide to 49px. The worst overhang left is 13px, on the
longest number over the smallest tile, and that is the honest limit rather than
a bug — eight characters do not fit in 36px and stay readable. It was 22px
before any of this.

A trailing `.0` is trimmed for the same reason — `52d`, not `52.0d`, which is
not more precise and is two characters wider. Gem badges are never fitted: a gem
row has the width of the panel behind it, so the number never has to give
anything up.

The vertical padding is uneven — `2.75px 6px 1.25px` — and that is what makes
the text look centred. Nothing a badge ever says has a descender: digits, `?`,
`≈`, `≥`, `d`, `c`. So the space the font reserves below the baseline is always
empty and the ink sits high in the box, measured at 3px above and 4.5px below.
Invisible on a 46px price; on a 20px square holding one `?` it is the only thing
in there. The bias closes it to 3.75 and 3.77 without changing the box.

**No badge is ever an empty box.** The item being priced on trade right now used
to blank to a grey skeleton, which says "no information" over an item that in
most cases already has poe.ninja's number on it. It keeps the number and changes
how it looks instead: solid amber border, 1.2s pulse. Only a rare with no
published price has genuinely nothing to show, and there it says `··`, which the
legend already defines as "still pricing".

**Every badge carries its unit**, in the one-letter form a player writes in a
whisper: `87.1d`, `10c`. It was briefly dropped on tiles under 80px to save
room, which on a real character page is every flask, every cluster jewel and
every base jewel — most of the grid reduced to bare numbers, where `8.0` could
be eight chaos or eight divine and nothing on screen said which. A badge whose
number means nothing is not worth the pixels it saves. What a small tile does
drop is the qualifier (`6L`), which genuinely does not fit; and above a thousand
divine the decimal goes, since `1285d` says everything `1284.6d` does.

There is no third unit to worry about. A seller can price a listing in anything
— exalts, annuls, a mirror — and `fetchPrices()` converts all of it to chaos
through poe.ninja's currency rates before the number ever reaches a badge.
Anything it cannot convert is recorded rather than dropped, so it stays a
question somebody can answer.

## Where the panel's item icons come from

Off the page, never over the network. poe.ninja has already downloaded the art,
and asking web.poecdn.com for it again would be a second copy of an image that
is sitting in the tab.

It draws the three kinds of item three different ways, and `iconSrcFor()` has to
know all three:

| | drawn as | found |
| --- | --- | --- |
| Equipment, flasks | a `<div>` the size of the item's grid footprint, art in `background-image` | two levels above the anchor |
| Gems | an `<img>` | in the anchor itself |
| Jewels | a 50×50 `<img>` in the jewel grid | two levels above the anchor |

Two rules. **Background art wins wherever it turns up**, because an equipment
tile also holds an `<img>` for every gem socketed into it, and reading images
first puts a gem's icon on the body armour. **An `<img>` counts only when it is
the only one in its subtree**, which is what stops the walk before it reaches a
container of several items and grabs a neighbour's art.

There was a third rule and it was wrong: `<img>` was ignored above the second
level, because `basicint`/`basicdex` kept coming back for jewel after jewel and
looked like the passive tree node underneath them. It is the jewel — a Cobalt
Jewel *is* drawn as `basicint`, a Viridian as `basicdex`. They repeat because
the base repeats. That rule blanked all nineteen jewels in the panel.

Measured on a live character: **14/14 equipment and flasks, 24/24 gems, 19/19
jewels, nothing blank.** The CSS mark is still there for an item poe.ninja does
not draw, but on a normal character page it never appears.

Two jewels of the same base do look alike, and that is the game, not a defect.
The icon tells a jewel from a pair of boots; the name and the micro-line tell
one jewel from another.

The art is not square — a belt is 94×47, a two-handed weapon 188×376 — so the
icon uses `object-fit: contain` and letterboxes rather than distorting. It is
**32px** rather than the 26px the design drew, which is free: the row is 46px
tall and its two lines of text are 34, so anything up to 34px grows into height
the row was already reserving. At 36px the rows start to grow and the list holds
fewer items.

## Fractured and crafted modifiers

`fractured.stat_3556824919` does not mean "has +12% global crit multi" — it means
"has it *and it is fractured*". Measured in one league: 7 listings against 2712
for the plain explicit id.

This was the single worst bug in the project. Every search containing a fractured
modifier came back empty, which sent the combination search down through every
subset, spending up to seven requests per item to arrive at a bad answer — and
that, not GGG's budget, was what made the extension sit and wait. Matching now
rewrites fractured and crafted ids to their explicit twin, and the three jewels
that provoked it went from `0 listings → 1 div after 12 s` to
`184 listings → 5 div after 1.8 s`.

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

```bash
node tools/cluster-test.mjs # a cluster jewel searched by its notables
```

```bash
node tools/gear-test.mjs    # a rare body armour: local stats, property filters
```

```bash
node tools/foulborn-test.mjs # an Allflame mutation, renamed on one side only
```

The one that matters most drives the **real service worker**, behind a mock
`chrome`, over one real item of every kind — rare gear in eight slots, rare and
abyss and cluster jewels, a Watcher's Eye, a corrupted unique, a Foulborn, a
plain unique — and six more taken off characters who are wearing them:

```bash
node tools/background-test.mjs
```

Every other test imports the library functions and calls them with arguments it
builds itself. That proves the libraries work and says nothing about
`background.js`, which is the code that actually runs. The first time this one
was pointed at it, every unique and every jewel came back
`ReferenceError: matchCorruptedImplicits is not defined` — the whole
variant-pricing path, dead, past a green suite.

Its fixture is real items pulled from trade, refreshed with:

```bash
node tools/collect-fixture.mjs
```

**And a second fixture of items nobody is selling.** Everything
`collect-fixture.mjs` collects came off a listing, so on the day it was collected
the widest query — the item's own modifiers at 80% of its own rolls — matched at
least the copy it was taken from. One search, one fetch, and the fallback ladder
never ran. That is not a matter of having picked easy items: it is what
collecting from a market means, and it is why three separate attempts at the
ladder measured as free when they were not.

Those items do drift into the ladder later, as their listings expire — one of the
seven rares was down it a day after collection — but that is the same measurement
being run against a quietly different fixture each week.

`tools/fixtures/worn.json` is items harvested off real character pages, where no
such guarantee exists, and where the ones that miss are exactly the ones a build
is full of. The file says how to refresh it — the extension's own bridge already
publishes the JSON, so it is two lines in the page console.

Each item now reports where its requests went:

```
worn medium cluster  Soul Shine Medium Cluster Jewel     6.1 div    20 listings >= reliable
                     explicit.stat_1882129725, explicit.stat_3051562738, …
                     wide 1s+0f  fallback 6s+3f  |  10 http
```

`10 http` is what actually went over the wire, so a run also shows when two items
built the same query and the second was answered from the cache. There is a table
of the same split at the end, and a warning if no item reached the ladder at all —
which is the state the suite was in until now.

That warning is the point of all of this. The slow path is the one every future
"this will be faster" has to be judged on, and for three of them there was
nothing to judge: the pass total did not move because the ladder was never in it.

One that shows what a query *asks for* rather than what it returns, and spends
no search budget at all — `/api/trade/data/stats` carries no rate-limit headers
and poe.ninja is a different budget entirely, so it runs as often as you like:

```bash
node tools/query-test.mjs          # every fixture item
node tools/query-test.mjs --diff   # only the ones asking a duplicate question
```

It prints the modifiers that reached the query and, for the ones that did not,
which of four reasons: no stat id at all, a pseudo or property filter already
carries it, it is not in the published roll pool, or the six-filter cap cut it.
Lumping those together hid three real bugs, including every modifier worded
"reduced" silently failing to translate.

One that needs no network, and catches what the others cannot — a script the
page never loads, a helper the caller never passes, a parameter a function reads
but never declares, a name passed to a function that nothing declares, an element
id nothing touches. Every one of those has shipped here at least once, and the
last two shipped on the same day:

```bash
node tools/check-wiring.mjs
```

If it ever stops recognising anything, from the page console:

```js
pncDiagnose()
```

dumps the candidate texts and icons so you can see what changed.

## Where a slow pass went

**Report a bug**, in the panel's footer and on the error banner, offers to save
this same JSON and copy it to the clipboard before it opens the tracker, so a
report can carry the one thing that makes it actionable. It says what the file
holds first: the items on a public character page, the searches they turned into
and what trade answered. Nothing about the person, no account, no session.

For us, after a trade pass, from the page console:

```js
pncReport()
```

downloads a JSON (and copies it, and prints a table) with, per item: the searches
it spent on the wide query, on the fallback ladder and on the broad last resort,
plus the two numbers that matter when a pass takes minutes —

- **held**: time our own rate limiter sat on the request,
- **on the wire**: time GGG had it.

Those have opposite fixes. Time on the wire is GGG being slow and nothing here
can help it; time held is the ladder asking too many questions, or the third of
every bucket we keep back for the player's own trade searches. The report also
dumps the limiter's live view of each bucket — `max`, `usable`, `spent` — so
"we are holding it back" and "GGG has no room" can be told apart rather than
guessed at.

The same split prints at the end of `background-test.mjs`.

**What the tests still do not cover.** Whether an item misses the wide query is a
property of the market on the day, not of the fixture: `worn.json` was three out
of six when it was collected and could be two or four next league. The run says
which, and warns at zero, so the answer is checked rather than assumed — but it
is not pinned, and it cannot be without mocking the API, which this suite is
deliberately not willing to do.

## Giving it to someone else

```bash
node tools/package.mjs
```

Builds `dist/poe-ninja-build-cost-<version>.zip` with an INSTALL.txt, for
"Load unpacked". Chrome will not install a bare `.crx` from outside the Web
Store, so an unzipped folder is the only route that works without publishing.

It ships what the manifest names, what the HTML pages pull in, and what the
service worker imports. That last one is not optional: the first zip was built
without it and shipped a `background.js` that could not resolve `./lib/trade.js`
— an extension that installs cleanly and does nothing.

## Files

| File | What it does |
| --- | --- |
| `manifest.json` | MV3: permissions, content scripts, service worker |
| `src/background.js` | Service worker: messages, User-Agent, cache, appraisal |
| `src/content.js` | Panel, DOM scanning, badges, summary |
| `src/content.css` | Panel and badge styles, scoped under `#pnc-` ids |
| `src/ui.css` | Tokens, the icon mark and the shared controls, for the two extension pages |
| `src/page-bridge.js` | Pulls the item JSON out of the MAIN world |
| `src/lib/economy.js` | Economy API, price index, floor-price detection |
| `src/lib/trade.js` | Trade queries, rare appraisal, reliability |
| `src/lib/stats.js` | Mod text → `stat id`, pseudo-mods, roll pools |
| `src/lib/rate-limit.js` | Adaptive throttling from GGG's rate-limit headers |
| `src/settings.js` | Defaults and storage, shared by the panel and the options page |
| `src/options.html` `.css` `.js` | Options page |
| `src/popup.html` `.css` `.js` | Toolbar popup |
| `icons/` | Extension icons, generated by `tools/make-icons.mjs` |
| `tools/background-test.mjs` | Drives the real service worker over every kind of item |
| `tools/collect-fixture.mjs` | Rebuilds that fixture from real trade listings |
| `tools/package.mjs` | Builds the zip you hand a tester |
| `tools/check-wiring.mjs` | Static checks: scripts load, symbols resolve, files exist |
| `tools/preview.html` | The panel rendered against sample data, no extension needed |
| `tools/fixtures/` | Real texts, icons, items and mods from a character page |
| `tools/fixtures/worn.json` | Items off real characters, the only ones that miss the wide query |
| `tools/query-test.mjs` | What each query asks for, and what got dropped — costs no search |
| `docs/poe-modifiers.md` | How PoE's modifiers work and what each fact implies here |
| `docs/ui-design.md` | The 0.5.0 design handoff: tokens, every view, and the calls made building it |

## Licence

MIT. See [LICENSE](LICENSE).

Not affiliated with, endorsed by or connected to poe.ninja or Grinding Gear
Games. It reads two public APIs and the page you already have open; the names
are theirs.
