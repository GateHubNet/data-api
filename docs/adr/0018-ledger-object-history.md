# ADR-0018: Ledger object history in one generic table, read at query time

**Status:** Accepted. Amends [ADR-0010](0010-ripple-v2-wire-compatibility.md#amendment-7-2026-10-24-ledger-objects-and-delegation) (Amendment 7, items 84 to 93;
items 7 and 10 edited in place, item 54 gains a column). Applies [ADR-0015](0015-historical-account-state-from-clickhouse.md)'s approach (state from history, read
at query time) to ledger objects, and [ADR-0016](0016-nft-and-uritoken-data.md)'s coverage rule (`FeatureCoverageService`) to four more features. The design is in
[the ledger objects and delegation spec](../superpowers/specs/2026-10-24-ledger-objects-delegation-design.md), program 2 sub-project D5.

## Context
The explorer has a page for an escrow, a check, a payment channel and a delegation, and each shows what the object is **and what happened to it**: who created it,
what every transaction since did to it, and why it is in the state it is in. The index had none of that:

- **No object tables.** The original's escrows and paychannels tables were dropped (ADR-0010 items 7 and 10); escrow and channel moves are only *typed* in
  `balance_changes`, and nothing records a check or a delegation at all.
- **A ledger object has an ID and no list.** The explorer arrives with an ID (from a transaction, a search box, a link), and the history of one object is a
  handful of rows, but a payment channel claimed every day for years has thousands. The per-account lists the original had (`/accounts/{address}/escrows`,
  `/payment_channels`) stay out of scope.
- **Delegation is new** (`PermissionDelegationV1_1`, enabled on the XRP Ledger at ledger 107,524,865) and is **mis-booked today**: a
  delegated transaction carries a `Delegate` that signs it and pays its fee, and `BalanceChangesParser` put the fee row on the account it acted for. The delegate's
  own list has the transaction only when the metadata happens to name its account (a fee-free inner transaction of a Batch does not).
- **D7's supply needs the total of the native currency in open escrows**, as of a ledger, cheaply and often.

## Decision
1. **One generic ledger table, `object_changes`, holds the history of `Escrow`, `Check`, `PayChannel` and `Delegate`** (migration 013, parser version 7,
   `OBJECT_PARSER_VERSION`): a row for every created, modified or deleted node of a tracked type in a transaction's metadata, with the object's fields after
   the transaction, what changed, and the event it was. It is ordered by `(object_type, object_id, ledger_index, tx_index)`, so an object is a prefix of the key.
   Its narrow index **`account_object_changes`** has a row for the owner and one for the counterparty of each, with a `role`, so that the delegations an account
   gave and holds are each a prefix; it is written for every tracked type, so that the later per-account lists need no re-ingest. A later family adds a type to
   `TRACKED_OBJECT_TYPES` and its events to the parser, and keeps the table.
2. **The state is read at query time, from the history.** The state of an object is its newest row at or before the newest committed ledger `H`; its history is the
   rows. Every answer names `H` and its close time, and the `status` (`pending`, `can_be_finished`, `can_be_cancelled`, `closing`, `expired`, ...) is worked out at
   that close time. There is no aggregate of the current state of checks, channels or delegations, so there is **no aggregator lag**: the answer is exact as of the
   ledger it names. A detail embeds the newest 50 events, and `/history` pages through the rest.
3. **`escrows` is the only aggregate**, and it exists for D7's total: one row per escrow the index has seen (its current state) and a **sentinel** row
   (`escrow_id = ''`) that holds the open count, the sum of the native drops and `through_ledger`, the watermark of the job. The `escrows` job of the aggregator
   walks the ledgers in steps of 1,000,000 (`ESCROWS_STEP_LEDGERS`), recomputes the escrows touched in a step, and writes the **sentinel last, at every run
   whether or not an escrow changed**, so that its `through_ledger` follows the head: a run that fails before the sentinel leaves the old total and the old
   watermark agreeing, and the next run does the window again. Every `agg_dirty` slice (a re-ingest) recomputes the escrows of its ledgers as of the watermark.
   D7 reads it with `readEscrowed`, which answers `undefined` before the first run.
4. **The events come from the metadata.** The event of a row is decided from the transaction type, the action and the fields, in a fixed order (spec section 2.2) that the parser's tests
   pin with an independent oracle (an escrow: `create`, `finish`, `cancel`; a check: `create`, `cash`, `cancel`; a channel: `create`, `fund`, `claim`, `close_request`, `renew`,
   `close`; a delegation: `set`, `delete`; any of them `removed` when another transaction type deleted it); a change that none expects is `update` and is counted in
   `syncer_objects_unclassified_total`. A cash takes the delivered amount from the metadata's `DeliveredAmount`, else the served `delivered_amount`, else the
   transaction's `Amount`, never `DeliverMin`. A row is written whatever the transaction's result, and `result` keeps it.
5. **Coverage is D3's, applied per object type and per object.** `escrows`, `payment_channels`, `checks` and `delegations` are four features of
   `FeatureCoverageService`, all on `OBJECT_PARSER_VERSION`; the detail and the history of one object are `complete` also when its creation is indexed (D3's per-NFT
   rule). `delegations` is `unavailable` where `NetworkProfile.hasDelegation` is false: a feature a network cannot have is `complete: true` and its route reads no
   table. D5 computes no coverage of its own. **Xahau takes no amendment for escrows, payment channels and checks**: `Escrow` and `PayChan` are retired there and
   the amendments assembly reports `enabled` for a retired name only when the ledger's `Amendments` object lists it, which Xahau's does not, so a genesis ledger
   added to `xahau.json` would never reach the rule and the features would stay `complete: false` for ever. They are D3's case of a feature **without an
   amendment**, which starts at `NetworkProfile.firstLedger` (Xahau's first ledger, the same ledger the spec intended); `xahau.json` is not edited.
6. **The `Delegate` field is indexed by listing the delegate under its own account** (`account_transactions`, `is_initiator = 0`, always, even for a fee-free Batch
   inner transaction, where the metadata names no account of the delegate), not by a new column or filter; the account-transactions CSV gains a last column
   `delegate`. **The fee of a delegated transaction is fixed:** `feePayer(tx)` (the `Delegate` when there is one, else the `Account`) puts the `transaction_cost`
   row on the payer, and the same rule is applied to `payments.source_balance_changes` and `path_payments.source_amount`, which added the fee back to the source
   whoever paid it, and to `payments.destination_balance_changes` when the delegate is the Payment's `Destination` (a sweep to itself), whose native change had
   the fee taken out (it is what arrived, and none for a token payment to its delegate). It needs **a re-ingest** from the delegation amendment
   (`range-ingest --from 107524865 --to <deploy ledger> --reprocess`, about 415,000 ledgers on 2026-10-28 and about 20,800 more a day): the delegate rows, the
   corrected fee rows and the rollups follow (`agg_dirty`), and the `delegations` coverage then starts at 107,524,865: `complete: true`.
7. **Issued-token payment channels are typed with token amounts** (Xahau, `PaychanAndEscrowForTokens`). `BalanceChangesParser.channel()` read every amount as
   drops and called `dropsToNative` on a token's amount object, which throws: a `LedgerParseError` that halts the live runner (and fails a range chunk) at the first
   token channel ledger. It reads the amounts through the same `escrowValue` an escrow does, so a Xahau syncer halted on such a ledger resumes after the deploy.
   On Xahau the creator's line moves at each claim, so a claim's creator row is typed `paychannel_fund` with the claimed delta: the values match the ledger, and the
   label means something else than for a native channel.
8. **No node fallback in the API.** An object the index has no row of answers 404, and the explorer asks the node (`ledger_entry`) for it: the API does not call a
   node on a request for an object. `GET /v2/ledger_objects/{id}` tells which kind of object an ID is, so that the explorer's search can send a pasted ID to its page.
9. **The MPT amount object is defined here.** An amount in an answer is `{ currency, issuer?, value }`, and an MPT amount is `{ currency: <issuance ID>, issuer,
   value: <raw integer units>, mpt_issuance_id }`. D9 serves every MPT amount in this shape and adds the scale and the ticker through its `?ids=` batch, never in
   the amount. D5 serves MPT escrow amounts (the TokenEscrow amendment) before D9 exists.
10. **The routes** are GateHub extras (ADR-0010 Amendment 7): `/v2/escrows/{id}`, `/v2/checks/{id}` and `/v2/payment_channels/{id}`, each with `/history`,
    `/v2/accounts/{address}/escrows/{sequence}` (an escrow's ID is computed from its owner and sequence, so no table is needed), `/v2/accounts/{address}/delegations`
    and `/v2/ledger_objects/{id}`. The lists of an account's escrows and channels still answer 404.

## Consequences
- **Complete coverage waits for the history backfill.** Delegation is complete after its re-ingest. Escrows, checks and channels stay `complete: false` until
  every ledger from their enable ledger on (28,685,313 for escrows and channels, 56,219,905 for checks on the XRP Ledger; Xahau's first ledger) is written by
  parser version 7 or later: the program's one reprocess after its last parser version, or the history load from 32,570 ([ADR-0015](0015-historical-account-state-from-clickhouse.md)).
  Until then **an object created before the first version-7 ledger and untouched since is not in the index**: its route is 404 and the explorer shows it from the
  node, and one created before it and changed after it has a history that starts in the middle, with no `created`, and says `complete: false`. The coverage
  an answer carries is the only statement of this; D5 does no backfill of its own.
- **The cost of a read is the object's, not the network's.** An object is a prefix of the key; the detail reads one page of 51 rows, one prefix read for the
  creation when it is older than the page, and, for a channel, one for its counts (`funds`, `claims`). Delegations read the account's prefix of
  `account_object_changes` (at most 10,000 IDs: more is a 500 and a log line, a guard and not a page), then their newest rows 1,000 IDs at a time. Every read is capped
  at `H` and pinned by `read_rows` tests over a bulk of other objects' rows. The price is storage: one row for every change of every tracked object, with its fields
  and previous fields (`ZSTD(3)`), on every network, from the deploy on; the retention procedure drops the two tables with the other ledger tables.
- **A history is what the metadata said, so a failed attempt that changed nothing is not in it**, and a `tec` transaction that did change a tracked node is (none
  is recorded in the fixtures, and the recorded close of an expired channel is `tesSUCCESS`). An unclassified change is `update`, counted, and shown as such.
- **The `escrows` total reads one narrow row per escrow ever seen** (a few hundred thousand on the XRP Ledger), only on a run that changed something: tens of
  milliseconds. If it ever outgrows that it can be kept incrementally with the sentinel still written last, and readers do not change. A first run over all history
  (a rebuild after the history backfill) is about 80 steps of 1,000,000 ledgers: a step is never cut by the budget (it cannot resume partway), so a tick with a heavy
  step runs past the job's 2 s, and the job takes the ticks until its watermark reaches the head. The job has 2 s of the 30 s of a tick, which leaves `stats_live` 7 s
  when every job before it uses its budget. The sentinel's total and its watermark always agree. An escrow whose rows cannot be mapped is set aside, counted as an
  error by its ID, and the step commits without it.
- **The status is a function of the time of the answer**, so a cached answer (`private, max-age=60`) can be a minute stale in it; the explorer mirrors the rules
  (`object-status.ts`) for objects it reads from the node.
- **The fee fix changes history.** A re-ingested ledger's delegated transaction has a different `transaction_cost` row (on the delegate), different
  `source_balance_changes` and `source_amount` (and `destination_balance_changes` when the delegate is the Payment's `Destination`), and a new row for the
  delegate in `account_transactions`; the balance changes of an account that acted through a delegate are different before and after the reprocess of their
  ledgers, and the account-transactions CSV puts `fee` on the row of the account that paid it (the delegate's, not the sender's).
- **Deploy order:** migration 013 first (the writer inserts into the two new tables on every ledger, and a write to a missing table fails the batch), then the
  syncer, then the api, then the re-ingest ([operations](../operations.md#ledger-objects-and-delegation), [backfill](../backfill.md#ledger-objects-and-delegation-re-ingest)).
  The explorer turns its `LEDGER_OBJECTS` switch on in an environment once its API serves the routes on both networks, and `DELEGATION` once the re-ingest is
  done there (in the sandbox once the routes answer: its coverage is never complete).
- Rejected: one table for each type (the events and the reads are the same, and a later family would add a migration for each); the current state in an
  aggregate for every type (a lag that the history does not have, and a rebuild for each change of the rules); a fallback to the node in the API (a request that holds a
  node connection, and two sources that disagree); an event table for checks beside the ledger-features spec's `check_events` (escrows and channels need the same
  per-transaction facts, so it is folded into `object_changes`); a list of every escrow, check and channel of an account (ADR-0010 item 7: the explorer's Objects
  tab reads them from the node).
