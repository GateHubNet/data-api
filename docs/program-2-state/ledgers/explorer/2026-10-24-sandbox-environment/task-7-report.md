# Task 7: The Testnet badge: report

Status: DONE_WITH_CONCERNS (one layout concern, below). Commit `5892906 feat(sandbox): a Testnet badge after the logo on every page of the sandbox`.

## What was implemented

- `app/ui/components/Pill.tsx`: `PillTone` gains `"testnet"` (no icon of its own: `own` stays `null` for it).
- `app/ui/components/Header.tsx`: the brand `<Link>` is wrapped in `<div className="hdr__brandgroup">`; when `networkKindOf(useEnvironment()) === "testnet"` the group holds
  `<Pill tone="testnet" icon={null}>Testnet</Pill>` right after the link. No `title`. `useEnvironment()` reads the root's loader data, so the pages with no `/:net`
  data (the unknown network `/xrp`, the root error boundary, the not-found route) have the badge too; without root data it is "development" (no badge).
- `app/ui/components.css`: `.hdr__brandgroup` (flex, align-items center, gap 10px) and `.pill--testnet` (the declarations of the brief, verbatim). The phone rules are
  untouched: the brand's name goes (`.hdr__name`), the mark, the badge and the switch stay.
- `app/ui/tokens.css`: `--testnet-fg/-bg/-border` in the light block (`#7A4306`, `#FDF0D5`, `#EBC985`) and in both dark blocks (`#F5C866`, `#33240A`, `#5C4316`).

## Tests written

- `test/unit/tokens.test.ts`: "has the testnet badge's tokens in light and both dark blocks" (the six values, lower-cased); `describe.each` light / dark by choice / dark by system
  "keeps the badge's text above 7:1 / 9.5:1" which also pins that `.pill--testnet` draws `--testnet-fg` on `--testnet-bg`, so the pair tested is the pair drawn
  (computed: 7.06:1 light, 9.54:1 dark).
- `test/unit/pages-css.test.ts`: "draws the testnet pill as the board's .tnet" (the declarations of the brief) and one more for `.hdr__brandgroup` (flex, centred, 10px).
- `app/ui/components/components.test.tsx`: "Pill testnet has no icon of its own" (`<span class="pill pill--testnet">Testnet</span>`); a "the Testnet badge" group in "Header and Shell":
  under a sandbox root the `.hdr__brandgroup`'s children are the brand link, then the pill (`pill pill--testnet`, text `Testnet`, no svg, no `title` on pill or group);
  under production, development and no root the group is the brand alone and "Testnet" is nowhere in the page.
- `app/ui/routes-wiring.test.tsx`: "the root error page shows the badge in the sandbox" (the real `root.ErrorBoundary`, root data `sandbox`: the badge is the group's second child;
  and none under production, development and no data).
- `test/worker/environment-sandbox.spec.ts`: "/xrpl and /xrp show the badge in the server-rendered header" (inside `<header>`, `pill--testnet` and `>Testnet<`, after the brand link, no `title`).
- `test/worker/layout.spec.ts` (development): "shows no Testnet badge" (`/xrpl`, `/xahau`, and the 404 of `/doge`).

## TDD evidence

RED (before the implementation):
`pnpm test test/unit/tokens test/unit/pages-css app/ui/components` -> `Test Files 3 failed | 11 passed`, `Tests 10 failed | 434 passed`:
tokens "has the testnet badge's tokens…" (`expected { '--bg': … } to match object { '--testnet-fg': '#7a4306', … }`), the three contrast cases and the pages-css
case (`no rule for .pill--testnet`), `.hdr__brandgroup` (`no rule for .hdr__brandgroup`), the four Header cases (`Cannot read properties of null (reading 'children')`: no group).
`pnpm test app/ui/routes-wiring` -> the root error page test failed (`Unable to find an element with the text: Testnet`).
"Pill testnet has no icon of its own" passes at runtime before the change (`pill--${tone}` already renders the class); its failure is the type error that `tsc -b` gave:
`components.test.tsx(97,40): error TS2322: Type '"testnet"' is not assignable to type 'PillTone | undefined'`.
Worker spec (run with the old `Header.tsx` / `Pill.tsx` put back for one run, then restored): `test/worker/environment-sandbox.spec.ts > the Testnet badge > /xrpl and /xrp show the badge in the server-rendered header`
failed (`expected '<header class="hdr"><div class="conta…' to contain 'pill--testnet'`); `layout.spec.ts`'s "shows no Testnet badge" passes before and after, as a negative guard should.

GREEN: `pnpm test test/unit/tokens test/unit/pages-css app/ui/components app/ui/routes-wiring` -> `Test Files 15 passed, Tests 531 passed`;
`pnpm vitest run test/worker/environment-sandbox.spec.ts test/worker/layout.spec.ts` -> `Tests 46 passed (46)`; after the last comment edits `pnpm test test/unit/tokens test/unit/pages-css app/ui` -> 65 files, 2134 tests passed.

## Verification

- `pnpm verify`: exit 0 on the second run (`Test Files 217 passed, Tests 9940 passed`, build, `bundle check passed: build/client`; network page 151.3 KB of 160, market-pair 150.1 of 160, account analytics 152.5 of 160).
  The first run had 4 worker specs time out at 5 s while the machine was busy (amendment-page, amendments-page, layout `/` redirect, transaction 503); run alone they pass (131 tests), and the second full run was clean.
- `pnpm fixtures:check`: 1051 generated fixture files are up to date.
- `pnpm test:e2e`: exit 0, 555 passed, 11 skipped (the axe scans run development: no badge).
- Visual check (dev server with `CLOUDFLARE_ENV=sandbox`, headless Chromium screenshots of `/xrp`, then stopped): the badge sits after the logo in light and dark; at 375 px and 320 px the logo's mark,
  the badge (61 x 23 px) and the switch are all there, and the page does not scroll sideways.

## Files changed

`app/ui/components/Pill.tsx`, `app/ui/components/Header.tsx`, `app/ui/components.css`, `app/ui/tokens.css`, `test/unit/tokens.test.ts`, `test/unit/pages-css.test.ts`,
`app/ui/components/components.test.tsx`, `app/ui/routes-wiring.test.tsx`, `test/worker/environment-sandbox.spec.ts`, `test/worker/layout.spec.ts`.

## Self-review

Complete against the brief (tone, group, badge placement, no `title`, tokens in three blocks, CSS, the six named tests plus the group's CSS check). No `app/server` value import added to browser code
(`Header.tsx` imports `networkKindOf` from `app/ui/environment` and `useEnvironment` from `app/ui/use-network`). The word "staging" appears nowhere in what I touched. Nothing outside the named files changed.

## Concern: the sandbox's desktop header wraps to two rows

Measured in the sandbox at 1240, 1280 and 1440 px wide (the container's content is 1200 px at most): the header is 125 px high instead of 68. The row holds the brand group (177 px with the badge, 105 without),
the switch (267 px, because its names are "XRPL Testnet" and "Xahau Testnet" since Task 4), the nav (483 px), the search (flex-basis 260 px) and the tools (44 px), with 20 px gaps: the search drops
under the other items. Without the badge, but with the testnet names, the tools alone drop to a second row (header still 125 px), so the wrap is already there from the longer switch names; the badge adds 72 px and
moves the search to the second row. Production and development (names "XRPL" and "Xahau") fit on one row, so the e2e suite and its axe scans are unaffected. Nothing overflows sideways at any width. The brief
fixes the markup and the CSS of the badge, so I did not touch the header's layout; if one row is wanted in the sandbox the choice is the controller's (a narrower search `flex-basis`, a tighter nav gap, or a smaller switch).
