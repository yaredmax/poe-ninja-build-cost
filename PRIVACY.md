# Privacy policy

**Build Cost for poe.ninja (unofficial)** — last updated 7 August 2026.

## The short version

The extension collects nothing about you. There is no account, no login, no
analytics, no telemetry, no error reporting, no advertising and no tracking of
any kind. Nothing is ever sent to the developer, and there is no server on the
other end to send it to.

## What it reads

When you press its button on a poe.ninja character page, it reads the items that
page has **already loaded** — their names, base types, modifiers, sockets and
quality. It does not fetch the character from anywhere; that data is on the page
in front of you and is public, since the character page itself is public.

It does not read any other page, and it does not run on any other site. The
content script is limited to `poe.ninja/poe1/builds/*` and
`poe.ninja/poe1/profile/*` by the manifest.

## What leaves your browser, and where it goes

Two destinations, both of them price sources, both of them contacted directly by
your browser:

- **poe.ninja's public economy API**, for published prices of uniques, gems and
  currency. Only a league name and a category are sent.
- **The official Path of Exile trade API at pathofexile.com**, to price rare
  items. Rare items have random modifiers, so no published price exists for
  them; the extension sends the item's own modifiers as a search and reads back
  what comparable items are listed for.

Those requests carry the item data described above and nothing else. They do not
carry your identity, and the extension never sends your Path of Exile session
cookie or asks you to sign in. If you happen to be signed in to pathofexile.com
in the same browser, your session cookie travels with requests to that domain
the same way it would if you used the trade site yourself, and Grinding Gear
Games' own privacy policy applies to it.

Nothing is sent anywhere else. There is no third destination.

## What is stored, and where

Both stores are your browser's, on your machine:

- **Settings** — minimum roll, which listings count, and whether to match a
  corrupted unique's implicit — in `chrome.storage.sync`, so they follow you
  between machines through your own Chrome profile.
- **Cached prices** in `chrome.storage.local`, kept for two hours. This is what
  makes reopening the same build free instead of spending Grinding Gear Games'
  request budget on questions already answered.

You can clear the cache at any time from the extension's options page. Removing
the extension removes both.

## Permissions, and why each exists

- **`storage`** — the two stores above.
- **`declarativeNetRequest`** — to set a descriptive `User-Agent` on the
  extension's *own* API requests, which poe.ninja's API documentation asks for
  and which `fetch()` will not let a script set. The rule is scoped to requests
  with no associated tab, so it never touches your browsing.
- **Host access to `poe.ninja` and `www.pathofexile.com`** — to read the build
  page and to ask the two price sources. No other host is contacted.

## Questions

Open an issue: https://github.com/yaredmax/poe-ninja-build-cost/issues

The extension is open source. Every claim above can be checked against the code
in this repository.
