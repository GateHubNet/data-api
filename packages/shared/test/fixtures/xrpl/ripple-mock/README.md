# Ripple mock ledgers

These 54 files are the real XRP Ledger ledgers used as mock data by the original Ripple Data API:

- Source: <https://github.com/ripple/rippled-historical-database>, directory `test/mock/ledgers/` (branch `master`).
- License: ISC, as declared in that repository's `package.json`. The ledger contents are public XRP Ledger data. They are
  copied unchanged; only the file names differ.

File names were changed from `"<index> - <label>.json"` to `<index>-<label>.json` (no spaces):

| Original                          | Here                            |
| --------------------------------- | ------------------------------- |
| `1021029 - accounts_created.json` | `1021029-accounts_created.json` |
| `2964124 - accounts_created.json` | `2964124-accounts_created.json` |
| `29136413 - escrow.json`          | `29136413-escrow.json`          |
| `29709909 - paychan.json`         | `29709909-paychan.json`         |

The other 50 files keep their original `<index>.json` name.

## Format

Each file is a bare, expanded ledger object in the old Ripple Data API shape: `ledger_index` is a string, `close_time` is
in ripple-epoch seconds, both `hash` and `ledger_hash` and both `totalCoins` and `total_coins` are present, and each
transaction carries `hash` and `metaData`. Most files have no `parent_close_time` or `close_flags`.
`normalizeLedgerResponse` (`src/ingest/raw-ledger.ts`) turns any of them into a `RawLedger`; load the whole directory
with `FixtureLedgerSource.fromDir`.

Parser golden tests count results over exactly this set, so do not add, remove or edit files here.
