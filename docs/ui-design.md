# The UI, as designed and as built

The design handoff for **0.5.0**, kept verbatim, plus a section at the end for
the calls that had to be made while building it.

It replaces `docs/ui-brief.md`, which was the *input* to the design — a
description of what the extension looked like before, written to hand to
somebody who was going to redraw it. That job is done and the brief described a
UI that no longer exists.

Everything below is the specification the code now implements. Where the two
disagree, this file is right and the code is wrong.

## Overview

Chrome extension that prices a Path of Exile character on poe.ninja. The user opens
a character page, presses a floating button, and the extension puts a price badge
over every item and a total in a side panel.

The design covers all five surfaces: the floating button, the in-page side panel,
the price badges over the items, the toolbar popup, and the options page.

**The one thing to understand before implementing:** there are two phases and the
second one is long. Phase 1 (poe.ninja prices) lands in under a second and is
provisional. Phase 2 (the trade pass) takes 2–6 minutes and arrives one item at a
time. Every layout below has to survive 60% of its rows being provisional for
several minutes.

## About the design files

The handoff came with `Build Cost Panel.dc.html`, a **design reference written in
HTML**: a flat canvas of annotated mockups side by side, not a working prototype
and not production code. It is **not in this repository** — it carries its own
bundled runtime and it is a picture, not a source file. The ids it uses (`1a`,
`2b`, `3a`…) are still referenced throughout this document, because that is how
the views are named.

What is in the repository is `tools/preview.html`, which renders the *shipping*
stylesheet against sample markup. That is the one to open when checking whether
something still looks right, precisely because it cannot drift: it links
`src/content.css` itself.

The views were recreated in the extension's own codebase with plain DOM and CSS.
That is the right choice for a content script whatever the fashion is: it is
injected into someone else's page, and every kilobyte of framework would be paid
for on every poe.ninja pageview.

## Fidelity

**High fidelity.** Colours, type sizes, spacing and states are final and exact.
Recreate them as specified. The only deliberately unfinished things are:

- Item icons are striped placeholders. In the real thing, reuse the art
  poe.ninja has already loaded on the page — no remote fetch, no CSP problem.
  (The handoff said "the `img src`"; for equipment and flasks there is no `img`.
  See "Changed after the first build".)
- The gear grid in `3a` is a stand-in for poe.ninja's real grid.
- The icon marks in `2d` are geometry, not artwork.

## Design tokens

### Colour

| Token | Hex | Used for |
| --- | --- | --- |
| bg / panel | `#12151b` | panel body, options page body |
| surface raised | `#161a21` | panel header, footer, popup header |
| surface hover | `#181c24` | row hover, annotation blocks |
| surface input | `#1b202a` | select, text inputs |
| surface chip | `#232935` | mod chips, slider track, skeletons |
| border | `#272c37` | panel border |
| border subtle | `#21262f` | internal dividers |
| border faint | `#1e232c` | options page dividers |
| border input | `#2f3542` | inputs, item icon frame |
| border strong | `#343a46` | secondary buttons |
| border hover | `#4a5262` | input/button hover |
| text | `#d8dce4` | primary text |
| text secondary | `#c3cad6` | tooltip body, gem names |
| text muted | `#a4abb9` | supporting prose |
| text dim | `#8b93a3` | labels, micro-lines, annotations |
| text faint | `#6d7482` | metadata |
| text decorative | `#5f6674` | counts next to section names — never body text |
| amber | `#e0a53c` | brand, progress fill, status dot |
| amber bright | `#e8b04a` | total, active values, floor chip text |
| amber pale | `#f0bc5c` | firm chip text, hover |
| amber deep | `#c9962f` | subtotals, unit next to the total |
| amber dark | `#8a6a2c` | dimmer half of the icon mark, toggle track |
| amber border | `#6b5426` | floor chip border, primary button border |
| badge solid | `#c8912e` | **badge fill over item art** |
| badge solid text | `#14100a` | text on that fill |
| badge dashed border | `#7d6335` | provisional badge |
| badge dashed text | `#a8905c` | provisional badge |
| warn bg / border | `#241d12` / `#3a2e19` | rate limit, not signed in |
| warn text | `#c9b48c` | " |
| error bg / border | `#241414` / `#3a1e1e` | trade unreachable |
| error text / accent | `#d0a8a8` / `#d98a8a` | " |
| success dot / text | `#6fa15c` / `#9db892` | finished |
| pending chip | `#8b7a52` on `#4a4230` dashed | provisional price in the panel |

Contrast rule that was enforced throughout: nothing below `#8b93a3` for text a
user has to read. `#6d7482` and `#5f6674` are for decoration only.

### Type

No web fonts — CSP forbids them.

- UI: `"Segoe UI", system-ui, -apple-system, Helvetica, Arial, sans-serif`
- Numbers, ids, timers: `ui-monospace, Consolas, monospace`

| Role | Size | Weight | Notes |
| --- | --- | --- | --- |
| Total | 34px | 700 | mono, `letter-spacing:-0.02em`, `line-height:1` |
| Total unit | 15px | 600 | amber deep |
| Options page title | 17px | 600 | |
| Panel header title | 13.5px | 600 | |
| Body / row name | 13px | 400 | |
| Settings label | 12.5px | 600 | |
| Row micro-line | 10.5px | 400 | mono, `#8b93a3` |
| Section label | 10.5px | 600 | uppercase, `letter-spacing:.09em` |
| Total label | 10.5px | 600 | uppercase, `letter-spacing:.1em` |
| Tooltip body | 11.5px | 400 | `line-height:1.5` |
| Price chip (panel) | 12.5px | 400 | mono |
| Badge (grid) | 11.5px | 700 | mono |
| Badge (68px tile) | 10.5px | 700 | mono |

### Other

- Radius: `2px` chip · `3px` control, chip, badge · `4px` tooltip, callout ·
  `5px`–`6px` panel · `50%` circles · `22px`–`24px` pills. **Never `50%` on
  anything whose width animates** — see the floating button at the end of this
  file; there it is `24px`, which draws the same circle and survives the change.
- Shadow: panel `0 18px 50px rgba(0,0,0,.55)` · popup `0 18px 44px rgba(0,0,0,.6)` ·
  button `0 6px 18px rgba(0,0,0,.55)` · badge `0 2px 6px rgba(0,0,0,.55)` ·
  tooltip `0 10px 26px rgba(0,0,0,.6)`
- Spacing inside the panel: `13px` horizontal everywhere; rows `6px` vertical;
  section headers `11px` top.
- The only keyframe animation:
  ```css
  @keyframes pncBlink { 0%,100%{opacity:.85} 50%{opacity:.35} }
  ```
  2s on provisional badges and rows, 1.6s on panel skeletons, 1.2s on the badge of
  the item being priced right now, 1.2–1.4s on the live status dot. **Never
  faster** — with 15 rows pulsing at once, anything quicker is nausea.
- Custom scrollbar (`.pnc-scroll`): 9px wide, track `#12151b`, thumb `#333a48` with
  a 2px track-coloured border and 5px radius, `#4a5262` on container hover,
  `#8a6a2c` while dragging. Firefox: `scrollbar-width:thin;
  scrollbar-color:#3a4250 transparent`.

## The icon mark

Chosen: **two stacked diamonds** (`2d`, option C). A pile of currency rather than a
single divine orb — it reads as "a total", which is what the extension produces.

Geometry, for any size `n` (this is how it is built in the mockup):

```
container: position:relative; width: round(n * 1.27); height: n
back  square: left:0;  bottom:0; size round(n*0.72); background #8a6a2c; rotate(45deg); radius 1px
front square: right:0; top:0;    size round(n*0.72); background #e8b04a; rotate(45deg); radius 1px
```

Used at 9, 10, 11, 13 and 16px across the views. In the active floating button the
front diamond becomes `#12151b` and the back one `#8a5f14`, so the mark reads as a
hole punched in the amber circle. Edge-state headers recolour it: paused/empty
`#5c5238`/`#7a6a4a` at 55% opacity, error `#5c3232`/`#a35c5c`.

For the browser's 16/32/48/128px icons, ship it as a flat PNG set on `#1a1e26` with
a 9px-at-44 rounded square, or as SVG. It survives 16px because it is pure geometry.

---

## View 1 — The floating button (`2a`)

Injected into the poe.ninja character page. 48px circle, 24px from the right and
bottom edge of the viewport, `position:fixed`.

**States, in the order they happen:**

1. **Idle.** Appears only *after* the gear grid has been found in the DOM — fading
   in and rising 8px. Never earlier: before that it promises something it cannot
   do. `background:#1d2129`, `border:1px solid #3a4250`, the mark at 16px.
2. **Hover.** Grows into a 48px-tall pill, `border-radius:24px`, padding
   `0 18px 0 16px`, border `#6b5426`, label **"Price this build"** at 13px/600 in
   `#e8b04a` next to the mark. First-time users have no idea what a floating amber
   diamond does.
3. **Active — panel open.** The button **does not move.** The panel opens to its
   left and its bottom edge stops 80px short of the viewport bottom, so the button
   stays exactly where the cursor left it. Fill becomes `#e0a53c`; a 2px ring at
   `inset:-5px` (`rgba(224,165,60,.25)` with `border-top-color:#f0bc5c`) rotates
   while the trade pass runs. Pressing it again folds the panel away.
   **While hovered the ring stops rotating**: hover stretches the button into a
   pill and a spinner cannot follow that shape. It takes the pill's radius, goes
   to a flat `rgba(224,165,60,.45)` and breathes at 1.4s instead.
4. **Collapsed.** The panel folds into the button and the button becomes a 44px-tall
   pill carrying the total: mark at 13px + `1284.6 div` at 15px/700 mono in
   `#e8b04a`, on `#161a21` with a `#33394a` border. While still running it shows a
   14px spinner ring instead of the mark, the total in `#c9962f`, and
   `12/25 · ~3 min` in 11px mono `#6d7482`.

Nothing else belongs in the button. One button, one meaning — no settings, no
second action.

## View 2 — The side panel (`1a` running, `1b` finished, `1d` edge states)

`position:fixed`, docked right, **360px** wide, full height minus the 80px the
button occupies. Wider hides poe.ninja's gear grid; narrower breaks names like
*"Foulborn Romira's Banquet"*. Border `#272c37`, radius 6px.

Top to bottom:

**Header** — 11px/13px padding, `#161a21`, bottom border `#21262f`. Mark at 11px,
title "Build cost" 13.5px/600, then a right-aligned 11px mono chip in `#6d7482`
showing `12/25 · Grand Spectrum` — the same count and the same item name as the
status line below it, always. **No close button** — see "Changed after the first
build" at the end.

**Not-signed-in warning** (when applicable) — warn colours, 11.5px/1.45 text:
*"Not signed in to pathofexile.com — your rate limit is halved, so this pass takes
about twice as long."* plus a link *"Sign in, then re-run ↗"*. A 14px round
`!` badge, 1.5px `#d9a544` border. This is the one warning worth putting at the top,
because it doubles a four-minute wait.

**Progress block** — `#161a21`:
- Label row: "PRICING ON TRADE" · `12/25` · `~3 min left` (mono).
- 4px bar, track `#232935`: a solid `#e0a53c` fill for done, plus a 6%-wide
  `#8a6a2c` segment pulsing at 1.4s for the item in flight.
- Status line, 11.5px/1.4: a 6px pulsing amber dot, then
  `Grand Spectrum · waiting 23 s for GGG's rate limit`. This is where the user
  spends most of those minutes.
- **Pause** and **Stop**, small outlined buttons on the right. Stop's hover turns
  `#6b3a3a`/`#e08a8a`.

There is no queue preview and no "Next up" list. It was tried and cut: it earned
nothing and cost vertical space the item list needed.

**Total** — label "MINIMUM BUILD COST", then `1200.0` at 34px/700 mono in
`#e8b04a` with `div` beside it, a right-aligned `≈ 264k chaos` in 11px mono, and a
line: `44 of 56 items priced · 12 still provisional`. Labelled *Minimum* on purpose —
many items are deliberately priced low.

**Item list** — `flex:1`, `overflow-y:auto`, `.pnc-scroll`.

Section header per category: uppercase name, decorative count in `#5f6674`, a 1px
rule filling the gap, subtotal in 11.5px mono `#c9962f`. Categories ordered by
money: Equipment, Flasks, Jewels, Gems.

Row, `6px 13px`, `gap:9px`, hover `#181c24`:

1. **Item icon**, **32px** (the handoff said 26 — see "Changed after the first
   build"), radius 3px, `1px solid #313846`, `object-fit:contain` because almost
   none of the art is square. Taken off the page, though not the way the handoff
   says. This is the fix for "the name alone is not enough to tell what it is".
2. **Name**, one line, ellipsised. `×3` chip (10px mono on `#232935`) when grouped.
3. **Micro-line**, 10.5px mono `#8b93a3`: what the item is + the one fact that
   explains the price — `Boots · 53 listings`, `Helmet · 1 of 6 mods`,
   `Belt · poe.ninja`, `Cobalt Jewel · 4 variants published`,
   `Support gem · 12 listings`. It is the second identity cue when the icon is
   ambiguous, so it must stay readable — do not dim it. In the equipment slots it
   is the slot, as drawn. Everywhere else it is not — see "Changed after the
   first build".
4. **Price chip**, 12.5px mono:
   - firm: `#f0bc5c` on `rgba(224,165,60,.13)`, `2px 6px`
   - floor (`≥`, `±`): `#d9a544`, `1px solid #6b5426`, transparent
   - unknown (`?`): `#6d7482`, `1px dashed #343a46`
   - provisional: `#8b7a52`, `1px dashed #4a4230`, blink 2s
   - pricing right now: a 52×16 `#232935` skeleton
5. **(i)**, 15px circle, 9.5px serif `i`. Border `#4a5262`/`#8b93a3` normally,
   **`#d9a544` when the price is a floor or a guess** so the eye finds the rows
   worth reading. Hidden on provisional rows — there is no reason to show yet.

Row body links to the exact trade search that produced the number. The (i) opens the
tooltip and does not navigate.

**The (i) tooltip** — this is the improvement that was asked for. 288px, `#1c212b`,
`1px solid #3a4250`, radius 4px, `9px 11px`, opens below-right of the row and is
about 191px tall, so reserve space for it rather than guessing:

- Headline, 600, `#e8b04a`: `Worth at least 207.1 div`
- The badge's full `title` text, verbatim: *"53 listings matching 1 of the 6
  modifiers searched for, cheapest median. Replaces poe.ninja's published price.
  Priced on fewer mods than it has, so it is worth at least this."*
- Mod chips, 10px mono on `#232935`, with a `+4 more` overflow chip
- A divider, then 10.5px mono metadata: `medium confidence` · `7 searches` · `31 s`
- `Open this search on trade ↗`

Everything in it already exists in the code (the badge title, the listing count,
the confidence rating, the mods searched, the per-item search and time cost that
today only `pncReport()` prints).

**Footer** — `#161a21`, top border:
- Notes, 11px/1.5 `#6d7482`: which items are out of the total and why.
- **The symbol legend**, collapsible, on `#1a1f27` with a `#262c37` border:
  a `▾ What do the symbols mean?` row, then one line per symbol — `≈` priced on
  every mod, `≥` worth at least this, `±` several variants published, `?` no usable
  number, `··` still pricing. This is the only place the legend is reachable from,
  so it must not be buried.
- Links row: `Settings` (amber) · `Clear prices` (`#8b93a3`) · spacer ·
  `Report a bug` (`#8b93a3`) · **`Buy me a Scroll`** as a filled `#d9a544` button with
  `#0b0d11` text, hover `#f0bc5c`. It appears here as well as in the popup,
  deliberately. `Clear prices` is the panel's real exit and is described at the
  end of this file.

### Finished state (`1b`)

Same panel, same full item list, later in time. Differences only:

- Progress block → a green line: a 6px `#6fa15c` dot, `Done in 4 m 12 s · 25 items ·
  138 searches`. Background `#141a17`, border `#22301f`. **No `Details` link** — see
  "Changed after the first build".
- Total is firm; the sub-line reads `56 of 56 items priced`.
- One 10.5px line: `Priced at 80% roll, Instant Buyout. Cached for 2 h — reopening
  this build costs nothing.` **It now sits in the footer, under the notes**, not
  under the total — see the rule below for why it moved.
- **No *global* settings and no re-run button in the panel.** Anything that applies
  to every build lives in the popup and the options page only; a second copy in the
  panel is a second thing that can drift, and a re-run button invites requests the
  rate limit cannot afford.
- **One exception, and the test it has to pass: the control must have no twin.**
  Options *about this search* belong next to the number they change, because they
  exist nowhere else and so cannot fall out of step with anything. They are also
  drawn only when they apply — an option that cannot change the answer is worse
  than no option, so a build with no swap weapon set never sees the swap switch.
  The first of them is `Count the swap weapon set · 2 items, usually storage`, a
  checkbox directly under the total. It starts wherever poe.ninja's own
  `useSecondWeaponSet` says, rather than at a fixed default: the page already
  knows whether the build swaps weapons, and guessing "off" was overriding an
  answer we were being handed.

  The section list gains **Passive tree** between Gems and Other, for tattoos and
  runegrafts. They have no element on the page, so no badge; several copies of
  one tattoo are a single row with a `x14` count.

  That is also why the `80% roll` line moved down. It reads as configuration but
  is not one — the control for it is global and lives in the popup — and leaving
  it where the per-search options now go would have put a setting you cannot
  change next to switches you can. It stays visible as a fact, because it is what
  makes the total mean "one like this costs X" and not "this is worth X".

(In the mockup `1b`'s list is abbreviated to subtotals to save canvas room. In the
real panel it is the same full list as `1a`.)

### Edge states (`1d`)

- **Reading the character sheet** — 26px spinner ring, `Reading the character
  sheet…`. Before the first prices exist.
- **Nothing to price** — dimmed mark. *"This character has no equipment on
  poe.ninja. Open a character with a visible gear grid."*
- **Hard rate limit** — warn banner: *"GGG is rate-limiting hard. Waiting it out —
  resuming in 64 s, on its own. This build will take longer than the usual 2–6
  min."* The countdown is amber. **The only button is "Stop and keep poe.ninja
  prices".** No Resume: the normal waits between requests already resume by
  themselves, and a Resume button would force the user to babysit the panel for four
  minutes. Never auto-stop something the extension can finish alone.
- **Trade unreachable** — error banner: *"Trade is not answering. Stopped after 3
  tries."*, `Try again` + `Report a bug`. poe.ninja prices stay on screen; the ten
  trade items keep their provisional mark.

In every failure the total stays visible. It is provisional, not gone.

## View 3 — Badges over the items (`3a`, `3b`, `3c`)

Absolutely positioned over poe.ninja's item icons, `right:-4px; bottom:-7px` —
**outside** the corner, not inside it. Nothing of the item art is covered and the
badge never collides with the socket dots. Radius 3px, 11.5px/700 mono,
shadow `0 2px 6px rgba(0,0,0,.55)`, and `padding:2.75px 6px 1.25px` — the
uneven vertical is deliberate and is explained in "Changed after the first
build". Small tiles: `1.75px 5px 0.25px`.

Colour says how much to trust the number, not where it came from:

| State | Style | In the total? |
| --- | --- | --- |
| firm (`90.0 div`, `≈ 224.4 div`) | fill `#c8912e`, text `#14100a` | yes |
| skipped (`set II`) | `#12151b` fill, `1px solid #343a46`, text `#6d7482`, 9.5px UI face | no, on purpose |
| floor (`≥ 207.1 div`, `± 20 c`) | `#1b1710` fill, `1px solid #c8912e`, text `#e8b04a` | yes, as a minimum |
| unknown (`?`) | `#20242c` fill, `1px solid #3a4250`, text `#8b93a3` | no |
| provisional | `#1b1710` fill, `1px dashed #7d6335`, text `#a8905c`, blink 2s | not yet |
| pricing now | the provisional number, 1px solid `#e0a53c` on `#241d12`, `#e8b04a` text, blink 1.2s. `··` only when there is no number yet | — |

**The change from today:** the firm badge is solid amber with dark text instead of
amber-on-dark. Over a stack of loot art, dark-on-light is the only thing that reads
reliably — the current badge disappears against a bright unique. The hollow badge
keeps a dark fill so its outline stays visible.

Qualifiers like `6L` ride inside the badge at 9px, `opacity:.65`.

**Rules to keep:**

- The badge stays `pointer-events: none` so poe.ninja's own tooltip still opens.
  That is exactly why the panel needs the (i): the grid cannot carry the reason text.
- Hovering a panel row rings its badge with 1px amber, and vice versa. No movement.
  With 25 badges on screen this is the only way to tell which row is which item.
- **The unit is never dropped**, on any tile, at any size. Badges carry the
  one-letter form — `87.1d`, `10c` — the way a player writes it in a whisper.
  See "Changed after the first build". Long numbers lose the decimal instead:
  above a thousand divine, `1284.6d` becomes `1285d`. A trailing `.0` never
  survives either: `52.0d` is written `52d`.
- **Every badge is as small as its number allows**, and where that is still too
  wide for the tile the *type* shrinks rather than the tile giving way — 11.5px
  down to a floor of 8.5px. A common minimum width was tried and reverted; see
  "Changed after the first build".
- One badge per item. Where poe.ninja stacks two items in one slot (the I/II weapon
  swap), the badge follows the visible one.
- **Text lists** (gems): the chip goes at 11px straight after the name, 6px
  along, sized to its contents — not right-aligned into a column, which the
  handoff asked for and which was tried twice; see "Changed after the first
  build". A gem's badge carries **no qualifier**: its level and quality are
  already printed in the same row by poe.ninja.
- **Tiles under 80px** (cluster jewels, base jewels, flasks): 10.5px badge and the
  qualifier (`6L`) is dropped, which really does not fit. The unit is not — the
  one-letter form is the same width in a 46px corner as in a 98px one.

All of this is a restyle of what already renders. No new data, no new trade requests.

## View 4 — Toolbar popup (`2b`)

320px, `#12151b`, `1px solid #2b313d`, radius 5px.

- **Header** `#161a21`: mark at 10px, `Build Cost for poe.ninja`, `v0.5.1` in 10.5px
  mono on the right. Below it the status line, mirroring the panel: a 6px `#6fa15c`
  dot and *"Ready — press the button on the page"*, or an amber pulsing dot with
  `Pricing — 12/25, ~3 min left` and a 3px progress bar. The popup has to answer
  "is it still working?" without switching tabs.
- **Body**: `Minimum roll` — label row with the value in 12px/600 `#e8b04a`, a 4px
  slider (track `#232935`, fill `#d9a544`, 13px `#e8b04a` thumb), and a 10.5px hint
  *"How much of a rare's own roll a listing must match to count."*
  Then `Which listings count` as a select on `#1b202a`/`#2f3542`.
  Then a mono line `Cache: 18 builds · 2 h` with a `Clear` action.
- **Footer** `#161a21`: `All settings` outlined in amber · spacer ·
  `Report a bug` · `Buy me a Scroll` filled amber.
- Changing a setting mid-run shows **"applies to the next run"**. Never restart a
  four-minute pass behind the user's back.

## View 5 — Options page (`2c`)

Two panes filling the window. The handoff drew a 720px card centred on the page;
it is built full-bleed instead, for the reason in "Changed after the first build".

**Sidebar**, 200px, full height, `#161a21`, right border `#21262f`: the mark + "Build Cost", then
`Pricing` (active: `#e8b04a`, `2px` left border `#e0a53c`, `rgba(224,165,60,.06)`),
`Cache`, `About`.

**Content**, `30px 34px`, `gap:26px`, panes capped at 760px so a paragraph does not
stretch across a wide monitor. It is the part that scrolls, and the only part:
`overflow-y:auto` on the pane region, 4px thumb `#2f3542` inset in a 10px gutter.
Title 17px/600 and, under it, *"Saved as you change them. Applies to the next run."*

Every setting is a **two-column row: explanation left (184px), control right**,
separated by `1px #1e232c` rules. The current page stacks the paragraph above the
control, which makes the eye re-scan to find what it is reading about. Nothing is
added — the same four settings as today, with their existing copy:

1. **Minimum roll** — slider with the value at 13px/700, and mono end labels
   `0 · anything matches` / `100 · exact roll`.
2. **Which listings count** — select, max 280px.
3. **Corrupted uniques** — a 32×18 toggle (track `#8a6a2c`, 14px `#e8b04a` knob) and
   "Search for the corruption implicit", plus the note about turning it off when a
   corrupted unique finds nothing.
4. **Cached prices** — `Clear cached prices` outlined button and a mono
   `18 builds · 412 items` beside it.

Footer row: `Report a bug` · `Source` · spacer · `Buy me a Scroll` filled amber. Pinned to
the bottom of the window on `#161a21` with a `#1e232c` top border, outside the
scroller, so it does not travel with the pane's length.

## Interactions and behaviour

- **No intermediate step before the run.** Pressing the button starts everything.
  Phase 1 is instant and free; asking permission first would cost a click on every
  single build. The trade pass starts on its own too, as today — it is pausable and
  stoppable instead.
- Button: fade + 8px rise in on injection. Hover expands to the pill (~150ms ease).
  Panel slides in from the right.
- Panel row hover ↔ badge ring, both directions.
- (i) opens on hover and on click (click for touch and for keyboard focus). It must
  not navigate.
- Badges and rows both link to the trade search that produced the number.
- Provisional → firm: swap the chip, stop the blink. Do not animate the number and
  do not reorder rows mid-run — the user is reading the list while it fills in.
  Re-sort by subtotal only when the pass finishes.
- The total recalculates as prices land, up or down.
- Pause holds the queue; Stop ends the pass and keeps what has arrived, marked
  provisional. Neither loses the poe.ninja prices.
- The floating button is the only thing that opens and folds the panel. Leaving for
  good is `Clear prices` in the footer, and nothing else does it.

## State

- `phase`: `idle | reading | ninja-priced | trading | paused | done | error`
- `items[]`: id, name, category, slot, ninjaPrice, tradePrice, symbol
  (`exact | floor | variant | unknown`), confidence
  (`high | medium | low | thin`), listingCount, modsSearched[], titleText,
  tradeUrl, iconSrc, groupCount, status (`pending | pricing | priced | failed`)
- `progress`: priced, total, currentItem, rateLimitWaitSeconds, etaSeconds
- `totals`: overall + per category, and how many items are excluded and why
- `settings`: minimumRoll (0–100, default 80), listingType, corruptedImplicit,
  persisted in extension storage; changes apply to the next run
- `cache`: keyed on item + league + settings, 2h TTL
- `session`: whether the user is signed in to pathofexile.com
- `ui`: panelOpen, collapsed, openTooltipId, legendExpanded, hoveredItemId

## Constraints (from the brief — non-negotiable)

- It sits on top of poe.ninja. The panel must not cover the items: the user needs
  badges and panel visible at once.
- **No external resources.** No Google Fonts, no CDN, no remote images. CSP forbids
  them.
- All styles namespaced `pnc-`. poe.ninja's classes are generated
  (`_text_11d3e_1`) and change every deploy — never depend on them for styling, and
  be defensive about how the gear grid is located in the DOM.
- Phase 2 takes minutes and arrives in drips. Assume 60% provisional for several
  minutes.
- Prices in chaos and divine; the conversion changes daily.

## Real numbers, for scale

25 items in the panel, about 10 of them going to trade. 4–5 sections. Longest names
are like *"Foulborn Romira's Banquet"*, and tooltip strings run to *"Added Small
Passive Skills also grant: Regenerate 0.15% of Life per Second"*. A typical total is
50–150 divine. The trade pass runs 2–6 minutes with single items stalling up to 45s.

## Assets

None to hand over. Item icons come from poe.ninja's own DOM at runtime. The icon
mark is CSS geometry (see above) and needs exporting as a PNG/SVG icon set for the
manifest. No fonts to bundle — system stack only.

---

## Where each view lives

| View | Built in |
| --- | --- |
| Floating button (`2a`) | `src/content.js` — `ensureFab`, `renderFab` |
| Side panel (`1a`, `1b`, `1d`) | `src/content.js` — `render` and the `render*` functions under it |
| Item rows and the (i) (`1c`) | `src/content.js` — `buildRow`, `updateList`, `openTip` |
| Badges (`3a`–`3c`) | `src/content.js` — `paintBadge`, `placeBadge` |
| Toolbar popup (`2b`) | `src/popup.html` · `src/popup.css` · `src/popup.js` |
| Options page (`2c`) | `src/options.html` · `src/options.css` · `src/options.js` |
| Icon mark (`2d`) | `src/ui.css` and `src/content.css` as CSS geometry; `tools/make-icons.mjs` for the PNGs |

Tokens live twice, on purpose: `src/content.css` scopes them under `#pnc-` ids
because it is injected into poe.ninja, and `src/ui.css` puts them on `:root` for
the two extension pages. They are the same hex values and the table above is the
authority for both.

## Decisions taken while building it

Four things the handoff did not settle, decided here so the code and the document
agree.

**The button collapses.** The design has both an "active" button that closes the
panel and a "collapsed" pill carrying the total, and nothing that triggers the
second. So: pressing the floating button while the panel is open folds it into
the pill, and pressing the pill opens it again — the run carries on either way
and the badges stay. (The real exit was the panel's ✕ until the first review;
see below.)

**The estimate is measured, not modelled.** `~3 min left` is the mean time the
finished items of *this* pass actually took, times the number left. It appears
once two items are done, because one is not an average. A model of GGG's buckets
would be more precise and would be wrong in the way that matters: it cannot see
the trade site the player has open in another tab spending the same allowance.

**"Not signed in" appears after the first item, not before.** GGG only names the
rules it applied once it has answered something, so before the first response
there is nothing to read. Guessing would nag people who *are* signed in.

**The cache counts items, not builds.** The design's `18 builds · 412 items` asks
for a number the storage does not hold: appraisals are keyed on what an item *is*
— which is why the same jewel on two characters costs one entry — and there is no
build in there to count. The popup and the options page say `412 items` and stop.

**"Stopped after 3 tries" is not claimed.** The trade layer does not retry, so
the error banner keeps the design's shape and its `Try again` button but reports
the actual failure instead of a retry count that never happened.

## Changed after the first build

Six things that only showed themselves once the whole thing was on a real
character page. The sections above already describe the current state; this is
what moved and why, so nobody re-derives the version that was taken out.

**Gem prices went back inline.** The handoff right-aligned them so they would form
a scannable column, and the code walked up from the gem's name looking for "the
flex row it sits in". On the real skills card that walk finds a container shared
by every gem in the section, so all six prices landed in a single strip on the
far right, next to nothing. The lesson generalises past the bug: a price on the
other side of a gap cannot be tied back to its name by eye, and the column the
design wanted only exists if poe.ninja's rows happen to be uniform. Inline, 6px
after the name, is worse in the mockup and better on the page.

**The item icons were never appearing, and the handoff's instruction was wrong.**
"Reuse the `img src` poe.ninja has already loaded" only describes gems. Measured
on a live character page, the three kinds of item are drawn three different ways:

| | how poe.ninja draws it | where it is, from the anchor |
| --- | --- | --- |
| Equipment, flasks | a `<div>` sized to the item's grid footprint, art as a CSS `background-image` | two levels up |
| Gems | an `<img>` | in the anchor itself |
| Passive jewels | a 50×50 `<img>` in the jewel grid | two levels up |

So there was never an `img` to find for the fourteen equipment and flask rows,
which is all of them, and no amount of widening the search would have produced
one. `iconSrcFor()` reads the computed `background-image` as well, under two
rules:

- **Background art wins wherever it is found.** An equipment tile also contains
  the `<img>` of every gem socketed into it — read images first and Blunderbore
  wears the icon of the gem in its first socket.
- **An `<img>` counts only when it is the only one in that subtree**, which is
  what stops the walk at a container of several items rather than letting it
  pick a neighbour's art.

There was a third rule and it was wrong, so it is written down here rather than
quietly deleted: `<img>` was ignored above the second level, on the grounds that
`basicint`/`basicdex` two levels above a jewel had to be the passive tree node,
since the same image came back for most of the jewels. It is the jewel. A Cobalt
Jewel *is* drawn as `basicint` and a Viridian as `basicdex` — they repeat because
the base repeats. The rule blanked all nineteen jewels in the panel, which is
what a build carries most of.

Measured after the change on one character: **equipment and flasks 14/14, gems
24/24, jewels 19/19, nothing blank.** The mark placeholder stays in the code for
an item poe.ninja does not draw, but on a normal character page it never shows.

Two jewels of the same base do look identical, and that is the game rather than
a defect: the icon separates a jewel from a pair of boots, and the name and the
micro-line separate one jewel from another.

**The ring stops turning on hover.** The 2px spinner is drawn as a rotating arc on
a 50%-radius box, and hover stretches the button into a 160px pill: the arc became
an ellipse sweeping around the label. A rotating pill outline is no better, so on
hover it takes the pill's radius and breathes in place instead.

**The ✕ is gone; `Clear prices` replaces it.** The header's close button sat one
glyph away from a floating button that merely folds the panel, and the two read as
the same gesture — except one of them threw four minutes of trade requests away.
There is now exactly one control for open/fold (the floating button) and one for
leaving (`Clear prices`, in the footer, spelled out, next to nothing pressed in a
hurry). It does what the ✕ did: stops the pass, clears the badges, returns the
button to idle.

**The options page fills the window.** A 720px card centred in a 1500px viewport
reads as small no matter what size the type is, because the empty page around it
is the scale the eye uses. The two panes are the window now: sidebar full height,
settings scrolling inside a box that never changes size, footer pinned. Switching
pane used to resize the card to whatever that pane needed, which moved the footer
and the sidebar's own edge out from under the cursor that had just clicked it.

**`Details` is gone; the diagnostics ride with the bug report.** The finished state
had a `Details` link that downloaded `pncReport()`'s JSON — request counts, per
item timings, which modifiers reached each query. That is a thing we read and
nobody else does. But it is also the only way to act on "the ring price was
wrong", and asking for it in an issue template gets it from about nobody. So
`Report a bug` now raises a sheet over the panel that says what the file contains
and that it holds nothing about the person, then writes it and opens the tracker.
Both buttons open the tracker straight from the click: `pncReport()` awaits the
rate limiter, and a `window.open()` past that await is a popup as far as Chrome
is concerned. The console still has `pncReport()` for us.

**The badge unit came back.** `formatBadgeAmount()` gave up the unit before the
decimals on any tile under 80px, which the handoff justified with "divine is
implied by the panel". On a real character page that is every flask, every
cluster jewel and every base jewel — most of the badges on screen — and `8.0`
with the panel closed is eight chaos or eight divine with nothing to separate
them. Badges now carry `d` or `c` everywhere, which costs one character and is
the same width at 46px as at 98px, so there was never anything to save. The
panel still spells `div` and `c` out, and the footer legend explains the two
letters, because that is the only place anything about the badges is explained.
There is no third unit to fit: `fetchPrices()` converts every currency a seller
can pick into chaos before it reaches a badge.

**The panel's icon is 32px, not 26px.** Small enough that a two-handed weapon —
188×376 of art, letterboxed into a square — came out a thirteen-pixel sliver.
The row is 46px tall and the two lines of text in it are 34, so the icon had
twelve pixels of the row's own height sitting unused beside it: measured, every
size up to 34px leaves the row exactly 46px and moves nothing below it. 32 takes
most of that and keeps a margin. Beyond 36px the rows start to grow and the list
holds fewer items, which is the trade the handoff was right to avoid.

**Gem prices, third attempt: the right end of the gem's own row.** The handoff
asked for a scannable column and was right; what was wrong both times was how
the row got identified. Taking the first wide flex ancestor found a container
shared by every gem in the card, and all six prices swept into one strip on the
far right. Falling back to "immediately after the name" then put them on a line
of their own underneath, because the anchor poe.ninja gives is a leaf span
inside a block cell — twenty gems at double height, each price detached from the
name above it.

The rule that works states the invariant instead of guessing at the markup: walk
up at most three levels for a flex row at least 120px wide, **and reject it if it
contains more than one priced item**, because then it is a section and there is
nothing better above it. Measured on a live character: 17 gems, 17 rows, 17
distinct containers, no fallbacks. The fallback is still there for when
poe.ninja's markup moves.

**A gem's badge carries no qualifier.** It was its level and quality, and
poe.ninja prints `21 / 20` in the same row a centimetre to the left. `6L` on a
weapon has no twin on the page and stays.

**The micro-line says what the item is, not which section it is in.** Outside the
equipment slots it was one word repeated down the whole panel — `Jewel` nineteen
times, `Gem` thirty — which named the section the row was already under and said
nothing about the row. None of the replacement is invented; it is GGG's own item
JSON, which the bridge already reads:

| | from | reads |
| --- | --- | --- |
| Gems | `support`, a boolean | `Skill gem` · `Support gem` |
| Jewels | `baseType` | `Cobalt Jewel` · `Medium Cluster Jewel` · `Timeless Jewel` |
| Flasks | `baseType` | `Silver Flask` · `Sulphur Flask` |
| Equipment | `inventoryId` | unchanged — `Boots`, `Amulet`, already different per row |

`support` is a boolean GGG publishes, taken in preference to reading the end of
the name: " Support" is a fact about English, not about the item. The base type
is dropped when it would only repeat the row's own name, which is what happens
to a flask nobody renamed — the row already says `Quicksilver Flask`, so the
micro-line says `Flask` and stops.

Measured on a live character: 47 of 57 rows say something they did not before,
and the ten that did not change are the equipment.

**Badge text is centred with uneven padding, on purpose.** `padding: 2px 6px`
put the ink 3px from the top and 4.52px from the bottom, because nothing a badge
ever says has a descender — digits, `?`, `≈`, `≥`, `d`, `c` — so the space the
font reserves below the baseline is always empty and the glyphs sit high by that
much. On a 46px price nobody sees it. On a 20px square holding a single `?` it
is the only thing there is to look at. `2.75px 6px 1.25px` leaves 3.75 above and
3.77 below, measured, and the box exactly as tall as it was. Small tiles get the
same bias at their own scale, `1.75px 5px 0.25px`.

**Nothing shows an empty box.** The item being priced right now blanked to a
56×19 grey skeleton, and that reads as "no information" over an item that in
most cases already has poe.ninja's number painted on it — hiding what we knew in
order to say we were busy. It keeps the number now and changes how it looks: a
solid `#e0a53c` border instead of the provisional dash, and a 1.2s pulse. The
skeleton survives only where there is genuinely nothing yet, a rare with no
published price, and even there it shows `··` rather than nothing, which is what
the legend already calls "still pricing".

**The floating button's hover loop.** Hovering near its bottom edge made it
flutter open and shut until you moved away. The cause is `border-radius: 50%`
on a box whose width is being animated: 50% is not a circle, it is *half of each
axis*, so at 120px wide the shape is an ellipse and its bottom pinches to a
single point at the centre. A cursor two pixels above the bottom edge is inside
the resting 48px circle and outside the ellipse the button becomes — so hover
drops, the button shrinks back, the cursor is inside again, and round it goes.

Three things now stop it, and the first is the actual fix:

- **`border-radius: 24px`**, which draws exactly the same circle on a 48px box
  but stays a stadium at every width. Point 2px above the bottom edge, dead
  centre: inside at 48px, 80px, 120px and 160px. With `50%` it is outside at all
  three of the larger widths.
- **An 8px invisible halo** (`#pnc-fab::before`, `inset:-8px`), so a pixel of
  slop cannot drop the hover. It also covers the resting circle's own corners,
  where the cursor could sit inside the bounding box and outside the button.
- **The label animates** rather than switching `display`, so folding back up is
  the same movement as opening instead of the text vanishing and the button
  catching up afterwards. `max-width` and `opacity`, with `gap` going 0 → 10px
  so the label costs nothing while hidden.

The ring gets a fixed 29px radius for the same reason — it was 50% of a 58px
box, which is the identical trap one layer out.

**Badges are as small as their number, and the number shrinks to fit.** One
common width was tried first — 65px in the grid, 58px on a small tile — to give
the eye a line to run down. It reads well when every tile is the same size and
poe.ninja's are not: a helmet is 98px and a ring 36px, so a single width left
`10c` marooned in a slab of padding on the big tiles and hung a badge off both
sides of the small ones. Both happened on the same screen, which is the answer.

So the box is the minimum the number needs, and `fitBadge()` scales the *text*
down where that still will not fit its tile — never up, and never below 8.5px,
where a price stops being worth printing. Measured on a live character page,
fourteen tiles:

| | |
| --- | --- |
| 78px tiles | nothing shrinks; badges 29–58px, all inside the tile |
| 36px tiles | short values untouched, `≈ 152.3d` goes 11.5px → 8.5px, 58px → 49px |
| worst overhang | 13px, on the longest number over the smallest tile |

That last row is the honest limit rather than a bug: eight characters cannot be
made to fit inside 36px and stay readable, and the floor decides which of the
two to give up. It is still better than the 22px the same badge overhung before
any of this.

Two things that went with it:

- **A trailing `.0` is trimmed.** `52.0d` is not more precise than `52d`, it is
  two characters wider for nothing.
- **`box-sizing: border-box` now covers `.pnc-badge` itself**, not only its
  children, so the width it reports and the width a tile reports mean the same
  thing.

**Gem prices, and this is the last word on it: straight after the name.** The
handoff wanted a scannable column of prices down the right of the skills card,
and it was built twice. Appending to the widest flex ancestor swept every price
in the card into one strip. Identifying "the gem's own row" and appending there
put the price on a line of its own *underneath* the name — and in a list of
twenty gems that is the worst of the three, because a number on its own line
belongs equally to the gem above it and the gem below it, and you end up
counting rows to find out which.

So: `insertAdjacentElement('afterend')` on the name, 6px of margin, sized to its
contents. Measured on a live character before committing to it — sixteen of
seventeen gems keep the badge on the name's line, with at least 103px still
spare in the cell, and the seventeenth is the duplicate the DPS block makes of
the main skill, which the scanner already suppresses.

The column was worth two attempts and is not worth a third. It only pays when
the rows are uniform, and poe.ninja's are not: the eye cannot scan a column that
half the rows do not reach.

**No `min-width` on gem badges**, unlike the corner ones. A common width buys a
column; inline after names running from "Enlighten" to "Awakened Cast On
Critical Strike Support" there is no column to buy, and all a minimum would add
is dead space between a name and its own price.

**The progress block reserves two lines, so nothing under it moves.** The status
line reads `<item> · waiting 23 s for GGG's rate limit`, and the waiting half
appears and disappears every few seconds for the whole length of a pass. One
line without it, two with: the block measured 81px then 92px then 81px, and the
total and the entire item list stepped 11px each way, over and over, while the
user was reading them.

`.pnc-what` now reserves `min-height: 32px` — two lines at 11.5px/1.4 — and
centres its content, so a single line sits level with the dot beside it instead
of at the top of an empty box. Measured across five item names with and without
the waiting text: one block height, 92px, and the list starts at the same pixel
in all ten.

The same fault was one level up and worse. The header chip already had
`white-space: nowrap` and `text-overflow: ellipsis`, and neither did anything,
because a flex item defaults to `min-width: auto` — "never shrink below your
content". So the chip held its full width, squeezed the title beside it, and the
*title* wrapped: 43px of header became 62px on a long item name, moving
everything. `min-width: 0` on the chip is what lets the ellipsis it already had
actually happen, and the title is `nowrap` too now.

**The donate button is "Buy me a Scroll".** A Scroll of Wisdom is the cheapest
thing in the game, which is the joke, and it is 100px against the 104px of "Buy
me a coffee" — 20px of slack in the panel footer, 24px in the popup.
