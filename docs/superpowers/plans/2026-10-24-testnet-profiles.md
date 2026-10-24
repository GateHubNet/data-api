# Testnet Profiles (D-env) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the same data API images on XRPL Testnet and Xahau Testnet as the sandbox's data APIs: four complete network profiles, and every process refusing another network's node, lists and files and keeping its data in a database of its own.

**Architecture:** `GH_NETWORK` takes four names, and the profile record (`packages/shared/src/network/network-profile.ts`) gains `family`, `kind`, `displayName`, `acceptedNodeNetworkIds` and `defaultUnlValidators`. Each place that branched on the network name now keys on the name (files, databases, caches), the family (amendment metadata, account flags) or the kind (the reset rule, the boot line). Xahau Testnet's fixed validator list is stored as the list of the reserved publisher `local`, so the tally, the agreement, the directory and the API read it with no branch of their own. The live runner tells a testnet reset (a validated head below the checkpoint under another hash) and halts. No migration, no parser version, no endpoint.

**Tech Stack:** TypeScript (strict), NestJS 10, ClickHouse 26.8 (`@clickhouse/client`), pnpm 10 workspace, jest + ts-jest, testcontainers, supertest, `ripple-address-codec` 5 (`decodeNodePublic`), `ripple-binary-codec` 2, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-10-24-testnet-profiles-design.md` (cited "§n", its decisions "D<n>"; the plan argues from the spec, executors read both). The explorer's side is x-explorer `docs/superpowers/specs/2026-10-24-sandbox-environment-design.md` (E7), built from its own plan.

**Branch:** `feat/explorer-data-2` in `/Users/golobitch/github.com/GateHubNet/data-api-worktrees/explorer-data-2` (stacked on PR #20). D-env is the first sub-project of the data API track; D3 (NFTs) follows on this branch and adds `firstLedger` to the four profiles written here, D4 `tomlNetworkNames`, D5 `hasDelegation`, D9 `hasMpt` (§1).

## Global Constraints

- Installs: Task 1 starts with `pnpm install --offline --frozen-lockfile` (the store `~/Library/pnpm/store/v10` holds the lockfile's packages, the private `@gatehub/toolbox` included), then `pnpm build`. If the offline install fails, try `pnpm install --frozen-lockfile` (your `~/.npmrc` token); if that fails too, stop and report BLOCKED naming the package. No `package.json` changes in this plan.
- The first e2e run pulls `testcontainers/ryuk`; if that fails, run the e2e suites with `TESTCONTAINERS_RYUK_DISABLED=true` and say so in the task report.
- The apps import the compiled `dist/` of `packages/shared`: after changing shared, run `pnpm --filter @gatehub/data-api-shared build` before app tests.
- Before each commit: `pnpm format`, `pnpm build`, `pnpm test`, and `pnpm --filter <package> test:e2e` of every package the task touched (`@gatehub/data-api-shared`, `@gatehub/data-api-service`, `@gatehub/data-syncer`) exit 0. `pnpm lint` does not run (the repo has no ESLint config, `docs/development.md` §4).
- Commits: Conventional Commits in the repo's style (`feat(shared): …`, `feat(syncer): …`, `feat(api): …`, `feat(exporter): …`, `build: …`, `test: …`, `docs: …`), a body that says why, and the last line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `--amend`, never `git add -A` or `git add .` (name the files), never touch `.claude/`. Delete nothing you did not create in the task.
- Numbering: D-env takes **no** migration (`packages/shared/schema/` stays at 010, `schema-shared/` at 002), **no** parser version (`rows.ts` unchanged), **no** ADR number: it amends ADR-0009, ADR-0012 and ADR-0010 item 44 in place (Task 11). D3 takes migration 011, `NFT_PARSER_VERSION = 5` and ADR-0016 after this plan.
- The four names, in this order everywhere a list of them is printed or tested: `xrpl`, `xahau`, `xrpl-testnet`, `xahau-testnet` (`NETWORK_NAMES`). "Testnet" is a fact of the profile (`kind`), never read from the environment: there is no second variable (D1).
- What keys on what (§3): files of markets and definitions, databases, `syncer_lease.network`, export object keys and cache keys key on the **name**; the amendment metadata file and the account-flag source key on the **family**; the reset rule and the boot line key on the **kind**. Parsers know no network (`parseContextFor` unchanged).
- Messages, verbatim: `GH_NETWORK must be one of xrpl, xahau, xrpl-testnet, xahau-testnet`; `--network must be one of xrpl, xahau, xrpl-testnet, xahau-testnet`; `Unknown GH_NETWORK "<name>"` (unchanged); `Node network_id <id> does not match GH_NETWORK=<name>` (unchanged); `GH_UNL_VALIDATORS entry <n>: must be a validator public key (n…)`; `GH_UNL_VALIDATORS entry <n>: repeats a key`; `GH_UNL_PUBLISHERS entry <n>: the id "local" is reserved`; `GH_UNL_THRESHOLD must be between 0 and the number of lists (<n>)` (Ruling 7); the two `ChainBreakError` messages of Task 9.
- `LOCAL_PUBLISHER_ID` is `'local'`; its `unl_lists` rows have `expiration` 4294967295 (2106-02-07T06:28:15Z, the `DateTime` maximum), `version` 1 and `publisher_key` `''`.
- Config only through the config classes; everything new of `packages/shared` is exported from `src/index.ts`, and anything a config class imports also from `src/network/index.ts` (the configs import only `@gatehub/data-api-shared/dist/network`).
- Recorded data comes from the public servers named in the task (outbound network). If one is unreachable, stop and report BLOCKED; never hand-write data presented as recorded. Each recording gets its provenance (endpoint, date, ledgers, node build) in `packages/shared/test/fixtures/README.md`.
- Mainnet behaviour does not change, except D10 (a `xahau` process refuses `network_id` 21338) and the compose defaults written out differently with the same result (Task 10).

## Review Focus

1. **A process pointed at another network's node.** A sandbox started with mainnet endpoints, a mainnet rippled (no `network_id`) under `xrpl-testnet`, a Xahau Testnet node under `xahau`: the boot fails naming `GH_NETWORK`, and `record:fixtures` refuses to record such a node under the testnet's name. Pinned by Task 3: `assertNetwork` table (`refuses a node that reports no network_id for xrpl-testnet`), `networkIdProblem refuses a mainnet rippled for --network xrpl-testnet`, and the syncer e2e `exits with an error when a Xahau Testnet node serves GH_NETWORK=xahau`.
2. **A testnet reset.** Today the syncer waits forever, healthy, when the node's head drops below the checkpoint. A head below the checkpoint with another hash, or (on a testnet) below the first indexed ledger, must halt with the message; a node that is merely behind (same hash) must not; the check runs once per distinct head and at most once a minute. Pinned by Task 9's six `live-runner.e2e-spec.ts` cases.
3. **Xahau Testnet with no publisher.** Without the fixed list nobody is trusted and the tallies and the validators pages say nothing. Four keys must be trusted at threshold 1, the summary must show `local` with no `expiration`, a restart with the same keys must write no new list, changed keys must write sequence + 1. Pinned by Task 7 (`writes the local publisher and its list at start`, `writes no list when the stored local list has the same keys`, `writes the next sequence when the keys changed`, `stored-lists.spec.ts` trust at threshold 1) and Task 8 (the Xahau Testnet e2e of the summary and the validator).
4. **Mainnet facts leaking into a testnet's amendments.** The family file's `enabled` entries are mainnet's ledgers and dates; on a testnet they must be dropped, the 15 `XRPL_RETIRE` amendments must read `enabled` (not "voting") with no `enabled` object, and an amendment of the testnet's own ledger must never carry `source: "metadata"`. Pinned by Task 5 (`a testnet reads its family's file and drops the enabled entries`, `exactly the 15 XRPL_RETIRE amendments are retired`, `assembleAmendments: a retired amendment not in the ledger has no enabled object`, the Xahau Testnet e2e of `/v2/network/amendments`).
5. **"The network's default" as compose spells it.** `GH_UNL_PUBLISHERS=default` (any case, spaces) and unset must give the network's publishers, empty must give none, the same for `GH_UNL_VALIDATORS`; the sandbox env file must yield the testnet names, blank endpoints and `default`, and the production example exactly what it yields today. Pinned by Task 6 (`syncer.config.spec.ts` cases) and Task 10 (the `docker compose config` check).

---

### Task 1: The four network profiles

**Files:**
- Modify: `packages/shared/src/network/network-profile.ts`, `packages/shared/src/network/network-profile.spec.ts`, `packages/shared/test/migrate.e2e-spec.ts`, `apps/api/Dockerfile` and `apps/syncer/Dockerfile` (the two testnet markets files in each one's list of shipped files)
- Create: `packages/shared/config/markets/xrpl-testnet.json`, `packages/shared/config/markets/xahau-testnet.json`, both exactly `{ "version": 1, "tradeMarkets": [], "paymentCurrencies": [] }` (§8, D8)

**Interfaces:**
- Produces (every later task; D3, D4, D5 and D9 add one field each to the same four records):
  ```ts
  export type NetworkName = 'xrpl' | 'xahau' | 'xrpl-testnet' | 'xahau-testnet';
  export type NetworkFamily = 'xrpl' | 'xahau';
  export type NetworkKind = 'mainnet' | 'testnet';
  /** In this order: the order of every message and test that lists them. */
  export const NETWORK_NAMES: readonly NetworkName[] = ['xrpl', 'xahau', 'xrpl-testnet', 'xahau-testnet'];
  export function isNetworkName(value: unknown): value is NetworkName;            // own keys of PROFILES only
  /** `<what> must be one of xrpl, xahau, xrpl-testnet, xahau-testnet` (the config classes and the scripts). */
  export function networkChoiceText(what: string): string;
  /** The network words of the boot lines (§3): `network=xrpl`; on a testnet `network=xrpl-testnet kind=testnet`. */
  export function networkLogText(profile: Pick<NetworkProfile, 'name' | 'kind'>): string;
  // NetworkProfile gains, after `name`:
  family: NetworkFamily;
  kind: NetworkKind;
  displayName: 'XRP Ledger' | 'Xahau' | 'XRPL Testnet' | 'Xahau Testnet';
  /** `server_info.network_id` values a node of this network may report; `undefined` is "the field is absent". */
  acceptedNodeNetworkIds: ReadonlyArray<number | undefined>;
  // and after `defaultUnlPublishers`:
  /** The `GH_UNL_VALIDATORS` text when that variable is unset or `default`: comma separated validator master keys (n…). */
  defaultUnlValidators: string;
  ```
  `PROFILES` becomes `Record<NetworkName, NetworkProfile>`; `getNetworkProfile` and `loadMarketsConfig` keep their signatures (by name); `definitionsFallback` reads `config/definitions/<name>.json` (the testnet files arrive in Task 4; until then they are `undefined`, the codec's built-in definitions).

The values (§1; the mainnet fields that exist today keep their values):

| Field | `xrpl` | `xahau` | `xrpl-testnet` | `xahau-testnet` |
|---|---|---|---|---|
| `family`, `kind` | `xrpl`, `mainnet` | `xahau`, `mainnet` | `xrpl`, `testnet` | `xahau`, `testnet` |
| `displayName` | `XRP Ledger` | `Xahau` | `XRPL Testnet` | `Xahau Testnet` |
| `networkId` | 0 | 21337 | 1 | 21338 |
| `acceptedNodeNetworkIds` | `[undefined, 0]` | `[21337]` | `[1]` | `[21338]` |
| `nativeCurrency` | `XRP` | `XAH` | `XRP` | `XAH` |
| `defaultDatabase` | `xrpl` | `xahau` | `xrpl_testnet` | `xahau_testnet` |
| `defaultNodeEndpoints` | today's | today's | `['wss://s.altnet.rippletest.net:51233', 'wss://testnet.xrpl-labs.com']` | `['wss://xahau-test.net']` |
| `partialPaymentFixLedger` | 4594094 | 0 | 0 | 0 |
| `software`, `tomlPath` | `rippled`, `/.well-known/xrp-ledger.toml` | `xahaud`, `/.well-known/xahau.toml` | `rippled`, `/.well-known/xrp-ledger.toml` | `xahaud`, `/.well-known/xahau.toml` |
| `defaultUnlPublishers` | today's | today's | `https://vl.altnet.rippletest.net=ED264807102805220DA0F312E71FC2C69E1552C9C5790F6C25E3729DEB573D5860` | `''` |
| `defaultUnlValidators` | `''` | `''` | `''` | `nHBoJCE3wPgkTcrNPMHyTJFQ2t77EyCAqcBRspFCpL6JhwCm94VZ,nHUVv4g47bFMySAZFUKVaXUYEmfiUExSoY4FzwXULNwJRzju4XnQ,nHBvr8avSFTz4TFxZvvi4rEJZZtyqE3J6KAAcVWVtifsE7edPM7q,nHUH3Z8TRU57zetHbEPr1ynyrJhxQCwrJvNjr4j1SMjYADyW1WWe` |
| `majorityHoldSeconds` | 1209600 | 432000 | 1209600 (Step 2) | 432000 (Step 2) |
| `amendmentThresholdPercent`, `flagInterval` | 80, 256 | 80, 256 | 80, 256 | 80, 256 |

- [ ] **Step 1: Install and build.** From the worktree root: `pnpm install --offline --frozen-lockfile`, then `pnpm build` (Global Constraints for a failing install).

- [ ] **Step 2: Check the two facts the spec leaves to the plan (D13, §5).** Outbound network; one request every 2 s to the testnet servers (the Clio drops bursts).
  - **Majority hold.** XRPL Testnet: JSON-RPC `account_tx` on `https://clio.altnet.rippletest.net:51234/` for `rrrrrrrrrrrrrrrrrrrrrhoLvTp` (the account of pseudo-transactions), `limit` 200, paging with its `marker`; among the `EnableAmendment` transactions find one `Amendment` with a `Flags: 65536` (tfGotMajority) and a later `Flags: 0`; the hold is the difference of their ledgers' close times, to within a flag interval (about 15 min). Xahau Testnet: the same against `wss://xahau-test.net` (its few days of history may hold no pair), else the `[amendment_majority_time]` stanza of the configuration in `Xahau/Xahau-Testnet-Docker` (absent: xahaud's compiled default). Write the value and where it came from in the profile's comment ("an EnableAmendment pair, <hashes>, 2026-10-…" or "<repo>@<sha> sets none: the software default"). If no source settles it, keep the table's value, write `not verified (<date>): <what was tried>` in the comment, and name it in the task report: it is an input the owner gives (overview, "Inputs needed from the owner").
  - **Xahau Testnet's validators.** Read `store/etc/validators-xahau.txt` of `Xahau/Xahau-Testnet-Docker` (`gh api 'repos/Xahau/Xahau-Testnet-Docker/commits?path=store/etc/validators-xahau.txt&per_page=1' --jq '.[0].sha'`, then `gh api 'repos/Xahau/Xahau-Testnet-Docker/contents/store/etc/validators-xahau.txt?ref=<sha>' --jq .content | base64 -d`; or `curl` the raw file at that commit). Its `[validators]` must be the four keys of the table, in any order. Write the file and the commit in the comment above `defaultUnlValidators`. If they differ, stop and report: the keys are D5's decision, the owner rules.

- [ ] **Step 3: Write the failing tests.**
  ```ts
  // network-profile.spec.ts (the existing tests stay)
  it('lists the four networks in their order', () =>
    expect(NETWORK_NAMES).toEqual(['xrpl', 'xahau', 'xrpl-testnet', 'xahau-testnet']));
  it.each(FOUR)('has the §1 values of %s', (name, values) => expect(getNetworkProfile(name)).toMatchObject(values));
  //   FOUR: one row per network with every field of the table above (acceptedNodeNetworkIds with toEqual, `undefined` included)
  it('gives every network a CTID id of its own', () =>
    expect(new Set(NETWORK_NAMES.map((n) => getNetworkProfile(n).networkId)).size).toBe(4));
  it('names a valid database of its own for every network', () => {
    const names = NETWORK_NAMES.map((n) => getNetworkProfile(n).defaultDatabase);
    for (const name of names) expect(assertValidDatabaseName(name)).toBe(name);
    expect(new Set(names).size).toBe(4);
  });
  it('throws on a network it does not know', () =>
    expect(() => getNetworkProfile('xrpl-devnet')).toThrow('Unknown GH_NETWORK "xrpl-devnet"'));
  it.each(['xrpl-testnet', 'xahau-testnet'])('ships empty markets for %s, which the volume jobs accept', (name) => {
    const markets = loadMarketsConfig(getNetworkProfile(name));
    expect(markets).toEqual({ version: 1, tradeMarkets: [], paymentCurrencies: [] });
    expect(() => assertValidMarketsConfig(markets, getNetworkProfile(name).nativeCurrency)).not.toThrow();
  });
  it('tells a network name from anything else', () => {
    expect(NETWORK_NAMES.every(isNetworkName)).toBe(true);
    expect(['bitcoin', 'XRPL', '', 'constructor', undefined].some(isNetworkName)).toBe(false);
  });
  it('words the choice and the boot line', () => {
    expect(networkChoiceText('GH_NETWORK')).toBe('GH_NETWORK must be one of xrpl, xahau, xrpl-testnet, xahau-testnet');
    expect(networkLogText(getNetworkProfile('xrpl'))).toBe('network=xrpl');
    expect(networkLogText(getNetworkProfile('xahau-testnet'))).toBe('network=xahau-testnet kind=testnet');
  });
  // migrate.e2e-spec.ts, in "against the real schema"
  it('(g) GH_NETWORK=xrpl-testnet creates and migrates xrpl_testnet', …);
  //   config = clickHouseConfigFromEnv({ GH_CLICKHOUSE_URL, GH_CLICKHOUSE_USER, GH_CLICKHOUSE_PASSWORD of the container, GH_NETWORK: 'xrpl-testnet' })
  //   expect(config.database).toBe('xrpl_testnet'); runMigrations({ config }) applies every file of schema/;
  //   `SHOW TABLES FROM xrpl_testnet` holds `ledgers` and `transactions`
  ```
- [ ] **Step 4: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-shared test -- network-profile` → FAIL (`NETWORK_NAMES` is not exported, `Unknown GH_NETWORK "xrpl-testnet"`).
- [ ] **Step 5: Implement** the types, the four records, the three functions and the markets files; add `config/markets/xrpl-testnet.json config/markets/xahau-testnet.json` to the file loops of `apps/api/Dockerfile` (line 38) and `apps/syncer/Dockerfile` (line 44). Every existing reader of `NetworkName` compiles unchanged (`account-flags.ts` keeps `profile.name === 'xahau'` until Task 4; `node-client.ts` gets two placeholder rows `'xrpl-testnet': [1], 'xahau-testnet': [21338]` in `ACCEPTED_NETWORK_IDS` until Task 3 removes the table).
- [ ] **Step 6: Run the tests to verify they pass.** `pnpm --filter @gatehub/data-api-shared test`, `pnpm --filter @gatehub/data-api-shared test:e2e -- migrate`, then `pnpm build && pnpm test` → exit 0.
- [ ] **Step 7: Commit.**
  ```bash
  git add packages/shared/src/network/network-profile.ts packages/shared/src/network/network-profile.spec.ts \
    packages/shared/config/markets/xrpl-testnet.json packages/shared/config/markets/xahau-testnet.json \
    packages/shared/test/migrate.e2e-spec.ts apps/api/Dockerfile apps/syncer/Dockerfile packages/shared/src/xrpl/node-client.ts
  git commit -F- <<'EOF'
  feat(shared): profiles for XRPL Testnet and Xahau Testnet

  A testnet is a network of its own (D1): every fact that differs (node ids, endpoints, lists, files,
  database) lives in one record, keyed by name, with the family and kind that the rest of the code
  branches on. The testnets ship empty markets and default to databases of their own.

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  EOF
  ```

---

### Task 2: The four names in the config classes, the scripts and the exports

**Files:**
- Modify: `apps/api/src/config/api.config.ts` (+ `api.config.spec.ts`), `apps/syncer/src/config/syncer.config.ts` (+ `syncer.config.spec.ts`), `apps/exporter/src/config/exporter.config.ts`, `apps/api/test/main.e2e-spec.ts` (line 178), `apps/api/src/app.module.ts`, `apps/syncer/src/app.module.ts`, `apps/exporter/src/app.module.ts` (the boot lines), `apps/syncer/src/cli/range-ingest.ts` (+ `range-ingest.spec.ts`), `apps/exporter/src/pdf-file.ts`, `packages/shared/scripts/record-fixtures.ts` (+ `record-fixtures.spec.ts`), `packages/shared/scripts/amendments-check.ts` (+ `amendments-check.spec.ts`), `docs/troubleshooting.md` (the message on line 57), `docs/configuration.md` (§2's `GH_NETWORK` row and the paragraph on line 17: the four values; §5a's exporter row)
- Create: `apps/exporter/src/config/exporter.config.spec.ts`, `apps/exporter/src/pdf-file.spec.ts`

**Interfaces:**
- Consumes: Task 1 `NETWORK_NAMES`, `isNetworkName`, `networkChoiceText`, `networkLogText`, `NetworkProfile.displayName`.
- Produces:
  ```ts
  // range-ingest.ts (exported now): the network whose CTID id is ctx.networkId, over NETWORK_NAMES
  export function networkOf(ctx: Pick<ParseContext, 'networkId'>): NetworkName;   // else throws as today
  // pdf-file.ts: the header's network line; the NETWORK_NAMES table of this file goes
  export function networkLine(network: string): string;   // `Network: ${getNetworkProfile(network).displayName}`, or `Network: ${network}` for a name no profile has
  ```
  The three config classes: `@IsIn(NETWORK_NAMES, { message: networkChoiceText('GH_NETWORK') })`. The scripts: `--network` checked with `isNetworkName`, refused with `networkChoiceText('--network')`, and every `xrpl|xahau` of their usage texts and header comments becomes `xrpl|xahau|xrpl-testnet|xahau-testnet`; `record-fixtures` `Options.network: NetworkName`. The boot lines start `${networkLogText(profile)}` where they wrote `network=${profile.name}`.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  // api.config.spec.ts and syncer.config.spec.ts (their loadConfig helpers), exporter.config.spec.ts (a copy of api.config.spec.ts's
  // loadConfig for loadExporterConfig, every case with GH_EXPORT_BUCKET: 'exports-test')
  it.each(NETWORK_NAMES)('takes GH_NETWORK=%s', async (name) => expect((await loadConfig({ GH_NETWORK: name })).cfg.network).toBe(name));
  it('refuses another network, listing the four', …);   // GH_NETWORK=bitcoin: exit 1, errors contain networkChoiceText('GH_NETWORK')
  it('defaults GH_NODE_ENDPOINTS to the testnet\'s public servers', …);   // api and syncer, GH_NETWORK=xrpl-testnet:
  //   'wss://s.altnet.rippletest.net:51233,wss://testnet.xrpl-labs.com'; xahau-testnet: 'wss://xahau-test.net'
  //   (every existing 'GH_NETWORK must be xrpl or xahau' assertion becomes the new message)
  // main.e2e-spec.ts line 178: ['GH_NETWORK', 'bitcoin', 'GH_NETWORK must be one of xrpl, xahau, xrpl-testnet, xahau-testnet']
  // range-ingest.spec.ts
  it('finds the network of each CTID id', () => {
    expect([0, 21337, 1, 21338].map((networkId) => networkOf({ networkId }))).toEqual(['xrpl', 'xahau', 'xrpl-testnet', 'xahau-testnet']);
    expect(() => networkOf({ networkId: 2 })).toThrow('No network has the CTID network id 2: pass the network option');
  });
  // pdf-file.spec.ts
  it('names the network by its display name', () =>
    expect(['xrpl', 'xahau', 'xrpl-testnet', 'xahau-testnet', 'other'].map(networkLine)).toEqual(
      ['Network: XRP Ledger', 'Network: Xahau', 'Network: XRPL Testnet', 'Network: Xahau Testnet', 'Network: other']));
  // record-fixtures.spec.ts: every '--network must be xrpl or xahau' becomes networkChoiceText('--network');
  it('records the lists of a testnet into its own directory', () =>
    expect(parseArgs(['--unl', '--network', 'xrpl-testnet']).out).toBe(resolve(<package>, 'test/fixtures/xrpl-testnet/unl')));
  //   and USAGE contains '--network xrpl|xahau|xrpl-testnet|xahau-testnet'
  // amendments-check.spec.ts (process.exit spied to throw, so that parseArgs stops where usage() exits; console.error spied)
  it('takes a testnet with its default endpoint', () =>
    expect(parseArgs(['--network', 'xahau-testnet'])).toEqual({ network: 'xahau-testnet', endpoint: 'wss://xahau-test.net', clickhouse: false }));
  it('refuses another network with exit 2', …);   // --network bitcoin: exit(2), console.error got networkChoiceText('--network')
  ```
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-shared build && pnpm test` → FAIL in the four packages (`xrpl-testnet` refused, `networkOf`/`networkLine` not exported).
- [ ] **Step 3: Implement** the decorators, the scripts' checks and texts, `networkOf` over `NETWORK_NAMES`, `networkLine` (and `renderPdf` writing it in place of the table lookup), the three boot lines, the two docs lines.
- [ ] **Step 4: Run the tests to verify they pass.** `pnpm build && pnpm test` and `pnpm --filter @gatehub/data-api-service test:e2e -- main exports` → exit 0 (the exports e2e still reads `Network: XRP Ledger`).
- [ ] **Step 5: Commit.**
  ```bash
  git add apps/api/src/config apps/api/src/app.module.ts apps/api/test/main.e2e-spec.ts apps/syncer/src/config \
    apps/syncer/src/app.module.ts apps/syncer/src/cli apps/exporter/src/config apps/exporter/src/app.module.ts \
    apps/exporter/src/pdf-file.ts apps/exporter/src/pdf-file.spec.ts packages/shared/scripts docs/troubleshooting.md docs/configuration.md
  git commit -F- <<'EOF'
  feat: GH_NETWORK, the scripts and the PDF header take the four networks

  The apps, record:fixtures and amendments:check accept xrpl-testnet and xahau-testnet with one message
  that lists all four; range-ingest finds a network by its CTID id among the four, the PDF header reads
  the profile's display name, and a testnet's boot line says kind=testnet.

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  EOF
  ```

---

### Task 3: A node of another network is refused

**Files:**
- Modify: `packages/shared/src/xrpl/node-client.ts` (+ `node-client.spec.ts`), `packages/shared/scripts/record-fixtures.ts` (+ `record-fixtures.spec.ts`), `apps/syncer/test/app.e2e-spec.ts`, `docs/syncer.md` (line 44: the accepted `network_id`s per network)

**Interfaces:**
- Consumes: Task 1 `acceptedNodeNetworkIds`.
- Produces: `assertNetwork(info, profile)` reads `profile.acceptedNodeNetworkIds` (`ACCEPTED_NETWORK_IDS` goes; its doc comment says the four rules of §4); `export function networkIdProblem(info: { network_id?: number }, profile: Pick<NetworkProfile, 'name' | 'networkId' | 'acceptedNodeNetworkIds'>): string | undefined` in `record-fixtures.ts` (exported now), `undefined` when `info.network_id` (absent included) is in `acceptedNodeNetworkIds`, else today's text `reports network_id <id>, but --network <name> is <networkId>` (Ruling 6).

- [ ] **Step 1: Write the failing tests.**
  ```ts
  // node-client.spec.ts: the table of §4, each cell; replaces the 'assertNetwork rejects xahau node for xrpl profile' cases
  it.each([
    ['xrpl', undefined, true], ['xrpl', 0, true], ['xrpl', 1, false], ['xrpl', 21337, false],
    ['xahau', 21337, true], ['xahau', 21338, false], ['xahau', 0, false], ['xahau', undefined, false],
    ['xrpl-testnet', 1, true], ['xrpl-testnet', undefined, false], ['xrpl-testnet', 0, false], ['xrpl-testnet', 2, false],
    ['xahau-testnet', 21338, true], ['xahau-testnet', 21337, false],
  ])('%s: a node reporting network_id %s is accepted: %s', (name, id, accepted) => {
    const check = () => assertNetwork(id === undefined ? {} : { network_id: id }, getNetworkProfile(name));
    if (accepted) expect(check).not.toThrow();
    else expect(check).toThrow(`Node network_id ${String(id)} does not match GH_NETWORK=${name}`);
  });
  // record-fixtures.spec.ts
  it('networkIdProblem refuses a mainnet rippled for --network xrpl-testnet, and takes the testnet', () => {
    expect(networkIdProblem({}, getNetworkProfile('xrpl-testnet'))).toBe('reports network_id undefined, but --network xrpl-testnet is 1');
    expect(networkIdProblem({ network_id: 1 }, getNetworkProfile('xrpl-testnet'))).toBeUndefined();
    expect(networkIdProblem({}, getNetworkProfile('xrpl'))).toBeUndefined();
    expect(networkIdProblem({ network_id: 21338 }, getNetworkProfile('xahau'))).toBe('reports network_id 21338, but --network xahau is 21337');
  });
  // apps/syncer/test/app.e2e-spec.ts, beside 'exits with an error when the node belongs to another network'
  it('exits with an error when a Xahau Testnet node serves GH_NETWORK=xahau (D10)', …);
  //   start(21338, { GH_NETWORK: 'xahau', GH_WORKERS: 'fee_stats' }): exit code 1, output contains
  //   'Node network_id 21338 does not match GH_NETWORK=xahau'
  ```
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-shared test -- node-client record-fixtures` → FAIL (`xahau` accepts 21338; `networkIdProblem` not exported).
- [ ] **Step 3: Implement** `assertNetwork` over the profile, the exported `networkIdProblem`, the doc line.
- [ ] **Step 4: Run the tests to verify they pass.** `pnpm --filter @gatehub/data-api-shared build && pnpm test`, `pnpm --filter @gatehub/data-syncer test:e2e -- app` → exit 0.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/shared/src/xrpl/node-client.ts packages/shared/src/xrpl/node-client.spec.ts packages/shared/scripts/record-fixtures.ts \
    packages/shared/scripts/record-fixtures.spec.ts apps/syncer/test/app.e2e-spec.ts docs/syncer.md
  git commit -F- <<'EOF'
  feat(shared): each network accepts exactly its own node network_id

  The accepted ids are a fact of the profile. A xahau process no longer ingests Xahau Testnet (D10), an
  xrpl-testnet one refuses a mainnet rippled, and record:fixtures applies the same rule, so a sandbox
  started with mainnet endpoints fails at boot naming GH_NETWORK.

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  EOF
  ```

---

### Task 4: Testnet ledgers, definitions and account flags

**Files:**
- Create (recorded): `packages/shared/test/fixtures/xrpl-testnet/recorded/` and `packages/shared/test/fixtures/xahau-testnet/recorded/` (three `<index>.json.gz`, `server_definitions.json`, `server_info.json`, `manifest.json` each), `packages/shared/config/definitions/xrpl-testnet.json`, `packages/shared/config/definitions/xahau-testnet.json` (copies of the two `server_definitions.json`), `packages/shared/src/network/account-flags.spec.ts`
- Modify: `packages/shared/src/network/account-flags.ts`, `packages/shared/src/network/network-profile.spec.ts`, `packages/shared/test/fixtures/README.md`, `apps/api/Dockerfile` and `apps/syncer/Dockerfile` (the two definitions files in each file loop), `apps/api/test/support/fixtures.ts`, `apps/api/test/tx-object.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 2 `record:fixtures --network <testnet>`, Task 3 its network check.
- Produces: `accountFlagsOf(profile)` takes the hand list when `profile.family === 'xahau'`, else `LEDGER_ENTRY_FLAGS.AccountRoot` of `profile.definitionsFallback()` (the network's own file); the cache stays keyed by name. API test seeds `'xrpl-testnet-recorded'` and `'xahau-testnet-recorded'` (`SeedName`, `DIRS`, `SEED_NETWORK` → `'xrpl-testnet'` / `'xahau-testnet'`, dirs `XRPL_TESTNET_RECORDED_DIR`, `XAHAU_TESTNET_RECORDED_DIR`).

- [ ] **Step 1: Record the testnets (outbound network).** From `packages/shared`, find a ledger, then record the three around it:
  ```bash
  FIND=$(mktemp -d)
  pnpm record:fixtures -- --network xrpl-testnet --endpoint wss://s.altnet.rippletest.net:51233 --out "$FIND/x" \
    --want Payment,OfferCreate,AMMDeposit,AMMWithdraw --scan 400
  pnpm record:fixtures -- --network xrpl-testnet --endpoint wss://s.altnet.rippletest.net:51233 \
    --out test/fixtures/xrpl-testnet/recorded --ledgers <N-1>,<N>,<N+1>
  ```
  `N` is a ledger the first run's `manifest.json` lists for `OfferCreate`, chosen so that the three hold a `Payment` of XRP and an `OfferCreate` (and an AMM transaction when one is within them). The same for Xahau Testnet from `wss://xahau-test.net` with `--want Payment,SetHook,URITokenMint`: three ledgers holding a `Payment` of XAH (a `SetHook` or `URITokenMint` when near). Copy each `server_definitions.json` to `config/definitions/<testnet>.json`. Write both recordings in `test/fixtures/README.md` (endpoint, date, ledgers, `build_version` of `server_info.json`, the types found).
- [ ] **Step 2: Write the failing tests.**
  ```ts
  // network-profile.spec.ts
  it('bundles the definitions of XRPL Testnet: XRPL types with AMM, no ClaimReward', () => {
    const d = getNetworkProfile('xrpl-testnet').definitionsFallback() as Definitions;
    expect(d.TRANSACTION_TYPES).toEqual(expect.objectContaining({ Payment: expect.any(Number), AMMCreate: expect.any(Number) }));
    expect(d.TRANSACTION_TYPES).not.toHaveProperty('ClaimReward');
    expect(d.LEDGER_ENTRY_FLAGS?.AccountRoot).toBeDefined();
  });
  it('bundles the definitions of Xahau Testnet: Import and ClaimReward', …);
  // account-flags.spec.ts (new)
  it('reads XRPL Testnet\'s flags from its own definitions file', () => {
    const flags = accountFlagsOf(getNetworkProfile('xrpl-testnet'));
    expect(flags).toEqual(expect.arrayContaining([{ name: 'DefaultRipple', bit: 0x00800000 }, { name: 'AllowTrustLineClawback', bit: 0x80000000 }]));
    expect(flags.map((f) => f.bit)).toEqual([...flags.map((f) => f.bit)].sort((a, b) => a - b));
  });
  it('gives Xahau Testnet the hand list of Xahau', () => {
    expect(accountFlagsOf(getNetworkProfile('xahau-testnet'))).toEqual(accountFlagsOf(getNetworkProfile('xahau')));
    expect(accountFlagsOf(getNetworkProfile('xahau-testnet'))).toContainEqual({ name: 'DisallowIncomingRemit', bit: 0x80000000 });
  });
  it('keeps one cached list per network name', () => {
    expect(accountFlagsOf(getNetworkProfile('xrpl-testnet'))).toBe(accountFlagsOf(getNetworkProfile('xrpl-testnet')));
    expect(accountFlagsOf(getNetworkProfile('xrpl-testnet'))).not.toBe(accountFlagsOf(getNetworkProfile('xrpl')));
  });
  // tx-object.e2e-spec.ts: describe.each gains ['xrpl-testnet-recorded', 'xrpl-testnet'] and ['xahau-testnet-recorded', 'xahau-testnet'],
  // so the binary round trip and the transaction tree run on the testnets' bundled definitions; and in the describe:
  it('computes the CTIDs of its network and books native payments in its currency', () => {
    const profile = getNetworkProfile(network);
    const suffix = { xrpl: '0000', xahau: '5359', 'xrpl-testnet': '0001', 'xahau-testnet': '535A' }[network];
    for (const { row } of all) expect(getTxCtid(row.ledger_index, row.tx_index, parseContextFor(profile).networkId).endsWith(suffix)).toBe(true);
    const native = fixturePayments(seed).filter((p) => p.row.issuer === '');
    if (seed.includes('testnet')) expect(native.length).toBeGreaterThan(0);
    for (const { row } of native) expect(row.currency).toBe(profile.nativeCurrency);
  });
  ```
- [ ] **Step 3: Run them to verify they fail.** Before the account-flags change: `pnpm --filter @gatehub/data-api-shared test -- account-flags` → FAIL (`xahau-testnet` reads definitions that have no `LEDGER_ENTRY_FLAGS`: "The definitions of xahau-testnet name no AccountRoot flags").
- [ ] **Step 4: Implement** `accountFlagsOf` by family, the two Dockerfile lines, the seeds.
- [ ] **Step 5: Run the tests to verify they pass.** `pnpm --filter @gatehub/data-api-shared build && pnpm test`, `pnpm --filter @gatehub/data-api-service test:e2e -- tx-object account-flags` → exit 0.
- [ ] **Step 6: Commit.**
  ```bash
  git add packages/shared/test/fixtures/xrpl-testnet packages/shared/test/fixtures/xahau-testnet packages/shared/test/fixtures/README.md \
    packages/shared/config/definitions/xrpl-testnet.json packages/shared/config/definitions/xahau-testnet.json \
    packages/shared/src/network/account-flags.ts packages/shared/src/network/account-flags.spec.ts packages/shared/src/network/network-profile.spec.ts \
    apps/api/Dockerfile apps/syncer/Dockerfile apps/api/test/support/fixtures.ts apps/api/test/tx-object.e2e-spec.ts
  git commit -F- <<'EOF'
  feat(shared): the testnets' own binary-codec definitions and account flags

  A testnet runs newer builds first, so each one ships the server_definitions of its own node (§7), and
  XRPL Testnet reads its account flags from that file while Xahau Testnet keeps Xahau's hand list. Three
  recorded ledgers of each testnet prove the CTID ids, the native currency and the binary round trip.

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  EOF
  ```

---

### Task 5: Amendment metadata on the testnets

**Files:**
- Modify: `packages/shared/src/validators/amendments-config.ts` (+ `amendments-config.spec.ts`), `packages/shared/config/amendments/xrpl.json` (15 `"retired": true`, `updated` the day of the change), `packages/shared/config/amendments/xahau.json` (the unnamed ID named, Step 5), `apps/api/src/validators/amendment-status.spec.ts`, `apps/api/test/amendments.e2e-spec.ts`, `packages/shared/test/fixtures/README.md`, `docs/operations.md` ("Keep the amendment metadata current": the sandbox's `amendments:check --network xrpl-testnet|xahau-testnet`, whose third list is always empty)
- Create (recorded): `packages/shared/test/fixtures/xahau-testnet/network-state/{amendments,negative_unl,fee_settings,server_info,feature}.json`

**Interfaces:**
- Consumes: Task 1 `family`; Task 2 `amendments:check --network <testnet>`.
- Produces (D3's coverage service relies on it: on a testnet an amendment's enable ledger comes only from an indexed `EnableAmendment`):
  - `loadAmendmentsConfig(profile, path?)` reads `config/amendments/<profile.family>.json` for an empty or blank path.
  - `parseAmendmentsConfig(raw, profile)` accepts `raw.network` equal to `profile.name` or `profile.family`, refuses anything else with today's text (`"<x>" is not the network of this deployment, "<name>"`), keeps the entries' `enabled` only when `raw.network === profile.name`, and returns `network: profile.name`.
  - `retired: true` is valid on both families (the `is for Xahau only` rule goes); `introduced` patterns stay by `software`.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  // amendments-config.spec.ts
  it('a testnet reads its family\'s file and drops the enabled entries', () => {
    const config = loadAmendmentsConfig(getNetworkProfile('xrpl-testnet'));
    expect(config.network).toBe('xrpl-testnet');
    expect(config.amendments).toHaveLength(loadAmendmentsConfig(getNetworkProfile('xrpl')).amendments.length);
    expect(config.amendments.filter((a) => a.enabled !== undefined)).toEqual([]);
    expect(config.byName.get('MultiSign')).toMatchObject({ retired: true, introduced: '0.31.0' });
    expect(loadAmendmentsConfig(getNetworkProfile('xahau-testnet')).amendments.filter((a) => a.enabled)).toEqual([]);
  });
  it('keeps enabled in a file whose network is the testnet\'s own name', …);
  //   parseAmendmentsConfig({ network: 'xrpl-testnet', updated: '2026-10-24', amendments: [{ name: 'AMM', enabled: { ledger_index: 5, date: '2024-03-22' } }] },
  //     xrplTestnet).byName.get('AMM')?.enabled → { ledger_index: 5, date: '2024-03-22' }
  it('refuses another family\'s file for a testnet, and a testnet\'s file for a mainnet', …);
  //   { network: 'xahau' } for xrpl-testnet → 'Invalid amendments config: network: "xahau" is not the network of this deployment, "xrpl-testnet"';
  //   { network: 'xrpl-testnet' } for xrpl → refused the same way
  // 'refuse a retired entry on XRPL, and accept one on Xahau' becomes 'accept a retired entry on both families'
  // 'XRPL: the withdrawn amendments are obsolete, and none is retired' becomes:
  it('XRPL: exactly the 15 XRPL_RETIRE amendments are retired, keeping their enabled', …);
  //   the same list of 15 as the Xahau test; each has its enabled; the four withdrawn ones are still obsolete
  // amendment-status.spec.ts
  it('assembleAmendments: a retired XRPL amendment that the ledger does not list is enabled with no enabled object', …);
  //   an XRPL config with MultiSign { retired: true, enabled: { ledger_index: 22178817, date: '2016-06-27' } }, a ledger without
  //   MultiSign's ID: status 'enabled', enabled undefined; with the ID in the ledger: the enabled object is there (mainnet unchanged)
  // amendments.e2e-spec.ts
  describe('Xahau Testnet (the family file without its enable ledgers)', …);
  //   startWithDirectory({ network: 'xahau-testnet' }); insertState with the IDs of the recorded
  //   xahau-testnet/network-state/amendments.json (node.Amendments) at its ledger; GET /v2/network/amendments:
  //   every ID of the ledger is a row with status 'enabled'; no row has an `enabled` object (no indexed EnableAmendment
  //   was seeded, and the file's are dropped); AMMClawback, HookOnV2 and RNG are named; nothing says source "metadata"
  ```
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-shared test -- amendments-config` → FAIL (`config/amendments/xrpl-testnet.json` is missing; `retired: is for Xahau only`).
- [ ] **Step 3: Implement** the loader's rules and the 15 marks in `xrpl.json`: `MultiSign`, `TrustSetAuth`, `FeeEscalation`, `PayChan`, `CryptoConditions`, `TickSize`, `fix1368`, `Escrow`, `fix1373`, `EnforceInvariants`, `SortedDirectories`, `fix1201`, `fix1512`, `fix1523`, `fix1528` (§6).
- [ ] **Step 4: Record Xahau Testnet's network state (outbound network).** From `packages/shared`: `pnpm record:fixtures -- --network-state --network xahau-testnet --endpoint wss://xahau-test.net` (default `--out` `test/fixtures/xahau-testnet/network-state`); its provenance in `test/fixtures/README.md`.
- [ ] **Step 5: Check the files against the testnets.** `pnpm amendments:check -- --network xrpl-testnet` and `-- --network xahau-testnet`. The 13 names §6 lists for Xahau Testnet are already in `xahau.json` (Ruling 9); the ID `AB6612F1B9C2EAB6F687512297D9960B13B869EFF97E77D85A0574DFF97FD1EE` is named from xahaud's `features.macro` (branch `dev` of `Xahau/xahaud`: the name whose SHA-512Half is the ID, `amendmentId(name)`): add `{ "name": "<it>" }` (with `introduced` when the macro's history dates it) to `xahau.json` and set its `updated`. Add whatever else either run lists, the same way; an ID no source names stays `unknown` (as on mainnet) and goes in the task report. Run both checks again: exit 0, or only IDs nobody names.
- [ ] **Step 6: Run the tests to verify they pass.** `pnpm --filter @gatehub/data-api-shared build && pnpm test`, `pnpm --filter @gatehub/data-api-service test:e2e -- amendments` → exit 0 (the mainnet cases unchanged).
- [ ] **Step 7: Commit.**
  ```bash
  git add packages/shared/src/validators/amendments-config.ts packages/shared/src/validators/amendments-config.spec.ts \
    packages/shared/config/amendments/xrpl.json packages/shared/config/amendments/xahau.json \
    packages/shared/test/fixtures/xahau-testnet/network-state packages/shared/test/fixtures/README.md \
    apps/api/src/validators/amendment-status.spec.ts apps/api/test/amendments.e2e-spec.ts docs/operations.md
  git commit -F- <<'EOF'
  feat(shared): testnets read their family's amendment metadata without mainnet's enable ledgers

  One file of names and descriptions per protocol (D6): a testnet keeps the names, versions, standards and
  retired marks and drops `enabled`, which records mainnet's ledgers and dates. XRPL marks its 15 retired
  amendments (D7), which XRPL Testnet's ledger never lists; mainnet's answers do not change.

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  EOF
  ```

---

### Task 6: `GH_UNL_VALIDATORS` and `GH_UNL_PUBLISHERS=default`

**Files:**
- Modify: `packages/shared/src/network/unl-publishers.ts` (+ `unl-publishers.spec.ts`), `packages/shared/src/validators/unl-list.spec.ts`, `apps/syncer/src/config/syncer.config.ts` (+ `syncer.config.spec.ts`), `apps/syncer/src/validators/unl-fetcher.ts` and `apps/syncer/src/validators/stored-lists.ts` (their config types only), `apps/syncer/test/support/validators-env.ts` (default `unlValidators: ''`), every `SyncerConfig`-shaped object of the validators unit specs (`unlValidators: ''`), `apps/syncer/.env.example`, `docs/configuration.md` (§5: the `GH_UNL_PUBLISHERS` row's `default` spelling and the XRPL Testnet and Xahau Testnet defaults, a `GH_UNL_VALIDATORS` row, the testnet defaults in the `GH_NODE_ENDPOINTS` row; §1's list of variables where empty means "off")
- Create (recorded): `packages/shared/test/fixtures/xrpl-testnet/unl/vl.altnet.rippletest.net.json`

**Interfaces:**
- Consumes: Task 1 `defaultUnlPublishers`, `defaultUnlValidators`.
- Produces:
  ```ts
  // packages/shared/src/network/unl-publishers.ts (importable from dist/network)
  export const LOCAL_PUBLISHER_ID = 'local';
  /** GH_UNL_VALIDATORS: comma separated, entries trimmed, empty ones skipped; each must decode with decodeNodePublic and be listed once.
   *  '' -> []; throws Error('GH_UNL_VALIDATORS entry <n>: <why>'), n counted over the non-empty entries. Returned in the order given. */
  export function parseUnlValidators(text: string): string[];
  // parseUnlPublishers also refuses an entry whose id, in lower case, is 'local': 'the id "local" is reserved'
  // apps/syncer/src/config/syncer.config.ts
  unlValidators!: string;   // GH_UNL_VALIDATORS, after unlPublishers
  export function unlValidatorsOf(cfg: Pick<SyncerConfig, 'unlValidators'>): string[];
  /** The publishers, plus one when the fixed list is not empty: what the threshold counts (rippled counts its local list so). */
  export function unlListCount(cfg: Pick<SyncerConfig, 'unlPublishers' | 'unlValidators'>): number;
  export function unlThresholdOf(cfg: Pick<SyncerConfig, 'unlPublishers' | 'unlValidators' | 'unlThreshold'>): number; // threshold > 0 ? it : defaultUnlThreshold(unlListCount(cfg))
  ```
  `MaybeEmptyText(fallback?, options?: { defaultWord?: boolean })`: with `defaultWord`, a value that is `default` after trimming, in any case, takes the fallback as an unset one does (Ruling 10); `GH_UNL_PUBLISHERS` and `GH_UNL_VALIDATORS` use it, with `defaultUnlPublishersOf` and a new `defaultUnlValidatorsOf` (the profile of `GH_NETWORK`). `IsUnlValidators` reports `parseUnlValidators`' message; `IsWithinPublishers` bounds `GH_UNL_THRESHOLD` by `unlListCount` with the message of Ruling 7.

- [ ] **Step 1: Record XRPL Testnet's list (outbound network).** From `packages/shared`: `pnpm record:fixtures -- --unl --network xrpl-testnet` (writes `test/fixtures/xrpl-testnet/unl/vl.altnet.rippletest.net.json`); provenance (URL, date, sequence, validator count) in `test/fixtures/README.md`.
- [ ] **Step 2: Write the failing tests.**
  ```ts
  // unl-publishers.spec.ts
  const XAHAU_TESTNET = ['nHBoJCE3wPgkTcrNPMHyTJFQ2t77EyCAqcBRspFCpL6JhwCm94VZ', 'nHUVv4g47bFMySAZFUKVaXUYEmfiUExSoY4FzwXULNwJRzju4XnQ',
    'nHBvr8avSFTz4TFxZvvi4rEJZZtyqE3J6KAAcVWVtifsE7edPM7q', 'nHUH3Z8TRU57zetHbEPr1ynyrJhxQCwrJvNjr4j1SMjYADyW1WWe'];
  it('parses XRPL Testnet\'s default publisher', () => expect(parseUnlPublishers(getNetworkProfile('xrpl-testnet').defaultUnlPublishers))
    .toEqual([{ id: 'vl.altnet.rippletest.net', url: 'https://vl.altnet.rippletest.net', publicKey: 'ED264807102805220DA0F312E71FC2C69E1552C9C5790F6C25E3729DEB573D5860' }]));
  it('parses the fixed list of Xahau Testnet', () =>
    expect(parseUnlValidators(getNetworkProfile('xahau-testnet').defaultUnlValidators)).toEqual(XAHAU_TESTNET));
  it('reads an empty text as no validators', () => expect([parseUnlValidators(''), parseUnlValidators(' , ')]).toEqual([[], []]));
  it.each([
    [`${XAHAU_TESTNET[0]},nonsense`, 'GH_UNL_VALIDATORS entry 2: must be a validator public key (n…)'],
    ['ED264807102805220DA0F312E71FC2C69E1552C9C5790F6C25E3729DEB573D5860', 'GH_UNL_VALIDATORS entry 1: must be a validator public key (n…)'],
    [`${XAHAU_TESTNET[0]}, ${XAHAU_TESTNET[0]}`, 'GH_UNL_VALIDATORS entry 2: repeats a key'],
  ])('refuses %j', (text, message) => expect(() => parseUnlValidators(text)).toThrow(message));
  it('reserves the id local', () => expect(() => parseUnlPublishers('https://LOCAL=ED264807102805220DA0F312E71FC2C69E1552C9C5790F6C25E3729DEB573D5860'))
    .toThrow('GH_UNL_PUBLISHERS entry 1: the id "local" is reserved'));
  // unl-list.spec.ts, beside the recorded lists of vl.ripple.com, unl.xrplf.org and vl.xahau.org
  it('verifies the recorded list of vl.altnet.rippletest.net with XRPL Testnet\'s key', …);   // version 1, one blob, validators > 0
  // syncer.config.spec.ts
  it.each(['default', 'DEFAULT', ' Default '])('takes GH_UNL_PUBLISHERS=%j as the network\'s default', …);   // on xrpl-testnet: the profile's text
  it('GH_UNL_VALIDATORS: unset and default are the network\'s, empty is none, a list is itself', …);
  //   xahau-testnet unset → the four (unlValidatorsOf); 'default' → the four; '' → []; `${K0},${K1}` → [K0, K1]; xrpl unset → []
  it('refuses a GH_UNL_VALIDATORS entry that is not a key', …);   // exit 1, 'GH_UNL_VALIDATORS entry 1: must be a validator public key (n…)'
  it('counts the fixed list among the lists', …);
  //   unlListCount: xahau-testnet defaults 1; xrpl defaults 2; xrpl with GH_UNL_VALIDATORS=K0 3. unlThresholdOf: xahau-testnet defaults 1.
  //   GH_UNL_THRESHOLD=2 on xahau-testnet → exit 1, 'GH_UNL_THRESHOLD must be between 0 and the number of lists (1)'
  //   (the existing 'the number of publishers (2)' and '(1)' assertions become 'the number of lists (2)' and '(1)')
  ```
- [ ] **Step 3: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-shared test -- unl-publishers unl-list` → FAIL (`parseUnlValidators` is not exported).
- [ ] **Step 4: Implement** the parser, the reserved id, the config property, its decorators and the three functions; `UnlConfig` of `unl-fetcher.ts` and the `cfg` type of `loadListContext` add `'unlValidators'`; the `.env.example` row (commented, with the Xahau Testnet default) and the docs rows.
- [ ] **Step 5: Run the tests to verify they pass.** `pnpm --filter @gatehub/data-api-shared build && pnpm test`, `pnpm --filter @gatehub/data-syncer test:e2e -- validators` → exit 0.
- [ ] **Step 6: Commit.**
  ```bash
  git add packages/shared/src/network/unl-publishers.ts packages/shared/src/network/unl-publishers.spec.ts packages/shared/src/validators/unl-list.spec.ts \
    packages/shared/test/fixtures/xrpl-testnet/unl packages/shared/test/fixtures/README.md apps/syncer/src/config apps/syncer/src/validators \
    apps/syncer/test/support/validators-env.ts apps/syncer/.env.example docs/configuration.md
  git commit -F- <<'EOF'
  feat(syncer): GH_UNL_VALIDATORS, a validator list fixed in the configuration

  Xahau Testnet has no publisher: its nodes trust the four keys of their [validators] section (D5).
  GH_UNL_VALIDATORS holds such a list and defaults to the network's; `default` now spells "the network's
  default" for it and for GH_UNL_PUBLISHERS, so compose no longer writes mainnet's publishers out (D12).

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  EOF
  ```

---

### Task 7: The fixed list in the validators worker

**Files:**
- Modify: `apps/syncer/src/validators/unl-fetcher.ts` (+ `unl-fetcher.spec.ts`), `apps/syncer/src/validators/stored-lists.ts`, `apps/syncer/src/validators/domain-checker.ts` (+ `domain-checker.spec.ts`), `apps/syncer/test/validators.e2e-spec.ts`
- Create: `apps/syncer/src/validators/stored-lists.spec.ts`

**Interfaces:**
- Consumes: Task 6 `LOCAL_PUBLISHER_ID`, `unlValidatorsOf`, `unlThresholdOf`; `readStoredLists`, `unlAt`.
- Produces:
  ```ts
  // unl-fetcher.ts
  export const LOCAL_LIST_EXPIRATION = 4_294_967_295;   // the DateTime maximum, 2106-02-07T06:28:15Z
  /** The unl_lists row of the fixed list: keys sorted, blob_sha256 = upper-case hex SHA-256 of the sorted keys joined by "\n",
   *  response = JSON.stringify({ validators: sorted }), effective = floor(now), fetched_at = now, version 1, publisher_key ''. */
  export function localListRow(keys: readonly string[], sequence: number, nowSeconds: number): UnlListsRow;
  // stored-lists.ts: loadListContext(ch, cfg: Pick<SyncerConfig, 'unlPublishers' | 'unlValidators' | 'unlThreshold'>):
  //   publishers = the configured ids, then LOCAL_PUBLISHER_ID when unlValidatorsOf(cfg) is not empty; lists read for all of them
  ```
  `registerPublishers()` (§5): when the fixed list is not empty it writes `{ publisher: 'local', url: '', publisher_key: '', configured: 1, threshold: unlThresholdOf(cfg), checked_at: now, status: 'ok', error: '', last_ok_at: now }`, and a `localListRow` with the newest stored `local` sequence + 1 (else 1) when the newest stored `local` list's validators, sorted, differ from the configured keys sorted (or none is stored); with an empty fixed list a stored `local` row that is `configured: 1` gets the `configured: 0` row the loop for unconfigured publishers already writes (that loop skips `local` while the fixed list is not empty). `local` is never a `Publisher` of the map: no timer, no fetch, no metric; `fetchOnce('local')` rejects as for any unconfigured id. The domain checker adds the fixed list's keys to the masters on a list in use (Ruling 8).

- [ ] **Step 1: Write the failing tests.**
  ```ts
  // unl-fetcher.spec.ts: describe('the fixed list (GH_UNL_VALIDATORS)'); K = four test keys (testKey('fixed-<i>').base58)
  it('writes the local publisher and its list at start', …);
  //   config { unlPublishers: '', unlValidators: K.join(',') }: registerPublishers() inserts the publisher row above with threshold 1,
  //   checked_at and last_ok_at NOW, and one unl_lists row: sequence 1, version 1, effective Math.floor(NOW), expiration 4294967295,
  //   validators [...K].sort(), blob_sha256 = sha256([...K].sort().join('\n')) in upper hex, fetched_at NOW,
  //   response JSON.stringify({ validators: [...K].sort() })
  it('writes no list when the stored local list has the same keys', …);         // stored seq 3 with K in another order: no unl_lists insert
  it('writes the next sequence when the keys changed', …);                       // stored seq 3 with K[0..2]: seq 4 with all four
  it('sets configured = 0 on a stored local publisher when the fixed list is empty', …);
  it('never fetches local: no timer, no fetch and no metric of it', …);          // with one URL publisher too: start() fetches the URL only;
  //   fetchOnce('local') rejects 'local is not a configured UNL publisher'; no validatorsUnlFetchesTotal label publisher 'local'
  it('writes the threshold in force counting the fixed list', …);               // one URL + local: 1; three URLs + local: 3 (both rows)
  // stored-lists.spec.ts (a fake ch whose query answers stored rows by `publishers`)
  it('reads the fixed list beside the publishers, and trusts its validators at threshold 1', …);
  //   cfg { unlPublishers: '', unlValidators: K.join(','), unlThreshold: 0 }: publishers ['local'], threshold 1, the query's
  //   publishers param ['local']; unlAt(context.lists, context.publishers, context.threshold, t) holds the four keys
  it('leaves local out when the fixed list is empty', …);
  // domain-checker.spec.ts
  it('checks the validators of the fixed list as on a list in use', …);          // a fixed-list key never seen is checked
  // validators.e2e-spec.ts
  it('Xahau Testnet: registers the fixed list as the publisher local, and a restart with the same keys writes no list', …);
  //   startValidatorsApp({ profile: getNetworkProfile('xahau-testnet'), node: a fake node whose server_info reports network_id 21338,
  //   config: { unlPublishers: '', unlValidators: <the four keys of Task 1> }, worker: { start: { state: false } } as boot() passes it}):
  //   unl_publishers has local (configured 1, threshold 1),
  //   unl_lists one local row (sequence 1); a second boot leaves one row
  ```
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-syncer test -- unl-fetcher stored-lists domain-checker` → FAIL (no `local` rows; `localListRow` not exported).
- [ ] **Step 3: Implement** `registerPublishers`' local rows, `localListRow`, `loadListContext`, the domain checker's line.
- [ ] **Step 4: Run the tests to verify they pass.** `pnpm --filter @gatehub/data-syncer test`, `pnpm --filter @gatehub/data-syncer test:e2e -- validators` → exit 0.
- [ ] **Step 5: Commit.**
  ```bash
  git add apps/syncer/src/validators/unl-fetcher.ts apps/syncer/src/validators/unl-fetcher.spec.ts apps/syncer/src/validators/stored-lists.ts \
    apps/syncer/src/validators/stored-lists.spec.ts apps/syncer/src/validators/domain-checker.ts apps/syncer/src/validators/domain-checker.spec.ts \
    apps/syncer/test/validators.e2e-spec.ts
  git commit -F- <<'EOF'
  feat(syncer): the fixed validator list is stored as the list of the publisher local

  Stored as a publisher's list, the fixed list is read by the tally, the agreement and the directory with
  no branch of their own. A new list is written only when the keys change, so past rounds keep the list
  that was in force, and local is never fetched.

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  EOF
  ```

---

### Task 8: The `local` publisher in the API

**Files:**
- Modify: `apps/api/src/validators/summary-object.ts` (+ `summary-object.spec.ts`), `apps/api/test/support/validators-seed.ts`, `apps/api/test/validators.e2e-spec.ts`, `docs/api-reference.md` (the summary's publishers: `local` is the fixed list of `GH_UNL_VALIDATORS`, with empty `url` and `public_key` and no `expiration`, §5's example; `unl_lists` may name `local`)

**Interfaces:**
- Consumes: Task 6 `LOCAL_PUBLISHER_ID`; Task 7's row shapes.
- Produces: `publisherOf(state)` leaves `expiration` out for `LOCAL_PUBLISHER_ID`; `url` and `public_key` are the stored `''`. `seedFixedList(ch: Ch, now: number): Promise<FleetMember[]>` in `validators-seed.ts`: the four members of `fleet('xahau-testnet', 4)`, the `local` publisher row (configured 1, threshold 1, status `ok`), one `local` list (sequence 1, version 1, effective and fetched an hour ago, expiration 4294967295, the four master keys), `validator_seen` rows a minute old, and the head the summary needs (`insertLedgers`, `insertState`, as `seedFleet` writes them).

- [ ] **Step 1: Write the failing tests.**
  ```ts
  // summary-object.spec.ts
  it('gives the fixed list (local) no expiration, and its empty url and public_key', …);
  //   buildSummary over a directory whose publisher local has a list expiring 4294967295: the publisher is exactly
  //   { id: 'local', url: '', public_key: '', status: 'ok', sequence: 1, version: 1, fetched: <instant>, validators: 4, seen_24h: 4 },
  //   keys in PUBLISHER_KEYS order
  // validators.e2e-spec.ts
  describe('Xahau Testnet: the fixed list', …);   // startHarness({ network: 'xahau-testnet' }), seedFixedList
  it('the summary trusts the four at threshold 1 and lists local', …);
  //   unl: { trusted: 4, threshold: 1, publishers: [the object above] }; `expiration` not a key of it
  it('a listed validator is on the UNL by the list local', …);
  //   /v2/network/validators?scope=unl and /v2/network/validators/{key}: unl true, unl_lists ['local']
  ```
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-service test -- summary-object` → FAIL (`expiration: '2106-02-07T06:28:15Z'`).
- [ ] **Step 3: Implement** the omission, the seed and the reference lines.
- [ ] **Step 4: Run the tests to verify they pass.** `pnpm --filter @gatehub/data-api-service test` (its `api-reference.spec.ts` included), `pnpm --filter @gatehub/data-api-service test:e2e -- validators` → exit 0.
- [ ] **Step 5: Commit.**
  ```bash
  git add apps/api/src/validators/summary-object.ts apps/api/src/validators/summary-object.spec.ts apps/api/test/support/validators-seed.ts \
    apps/api/test/validators.e2e-spec.ts docs/api-reference.md
  git commit -F- <<'EOF'
  feat(api): the validators summary lists the fixed list as the publisher local

  A fixed list does not expire, so local has no expiration; its url and public key are the empty strings
  it was stored with. Xahau Testnet's four validators are trusted at threshold 1 and their unl_lists say local.

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  EOF
  ```

---

### Task 9: A testnet reset halts the syncer

**Files:**
- Modify: `packages/shared/src/ingest/ingest-state.ts`, `packages/shared/test/ledger-writer.e2e-spec.ts`, `apps/syncer/src/ingest/live-runner.ts`, `apps/syncer/test/live-runner.e2e-spec.ts`, `docs/operations.md` (new "A testnet was reset", §11's runbook), `docs/troubleshooting.md` (the two messages: what they mean, the runbook), `docs/syncer.md` (the head-below-checkpoint check)

**Interfaces:**
- Consumes: Task 1 `kind`, `getNetworkProfile(cfg.network)`.
- Produces:
  ```ts
  // ingest-state.ts
  /** The lowest ledger whose `ledgers` row exists; `undefined` when none is (`minOrNull(ledger_index)`). */
  export async function firstCommittedLedger(ch: ClickHouseService): Promise<number | undefined>;
  // live-runner.ts
  export const HEAD_BELOW_CHECK_MS = 60_000;
  // LiveRunnerOptions gains: headBelowCheckMs?: number   (default HEAD_BELOW_CHECK_MS; tests shorten it)
  ```
  The rule (§11), as the runner applies it:
  - A head the source reports (a hint or a poll) below the committed checkpoint is recorded as the head below (the runner's `head` still never goes down). A check runs when that head differs from the last one checked and `headBelowCheckMs` has passed since the last check (the first at once), from the pipeline's loop.
  - The check: `storedLedgerHash(ch, head)`. With a stored hash: one `source.fetch(head)` (a failure is a warning, and the next due check tries again); another hash throws `ChainBreakError("The node's validated ledger <head> has hash <h1>, but ledger <head> is stored with hash <h2>: the network was reset, or the node is of another chain", head)` on every network; the same hash logs one warning per head (`The node's validated head <head> is below the checkpoint <checkpoint>, with the stored hash: waiting for it to catch up`) and waits. With no stored hash: when `head < firstCommittedLedger(ch)` and the profile of `cfg.network` is a testnet, it throws `ChainBreakError("The node's validated head <head> is below the first indexed ledger <first>: the network was reset", head)`; on a mainnet, or for a gap, it waits.
  - `prepare()` with a checkpoint asks `source.validatedHead()` first and runs the same check when the head is below the checkpoint, before it fetches the checkpoint (which then waits for a node that is behind, as today).
  - `ChainBreakError` halts as it does today (status `halted`, `/liveliness/healthz` 503).

- [ ] **Step 1: Write the failing tests.** In `live-runner.e2e-spec.ts` (Ruling 3), with `TestSource` (it gains `useChain(chain)`, which replaces its ledgers, for a node that changes chain under a running runner), `syntheticChain(…, { salt })`, `makeRunner` and its `cfg`/`options`; `headSilenceMs` shortened to 50 ms and `headBelowCheckMs` to 300 ms where the loop runs:
  ```ts
  it('halts at boot when the node\'s head is below the checkpoint under another hash: the network was reset', …);
  //   commit L(1)..L(10); a source of syntheticChain(L(1), 30, { salt: 'reset' }) with head L(5): runOnce rejects with ChainBreakError
  //   whose message is the first one above with head L(5); status { state: 'halted', checkpoint: L(10) }; source.fetches [L(5)]
  it('waits at boot when the node\'s head is below the checkpoint with the stored hash: the node is behind', …);
  //   the same chain, head L(5): the background loop is not halted after 500 ms; raising the head to L(12) commits L(11), L(12)
  it('halts while live when the head falls below the checkpoint under another hash', …);
  //   live at L(10); source.useChain(the 'reset' chain) with head L(3): halted with the message, ledgerIndex L(3)
  it('checks a head below the checkpoint once per distinct head and at most once per headBelowCheckMs', …);
  //   live at L(10), same chain, head L(5): after 700 ms of polls fetchCount(L(5)) is 1 (the same head is not checked again);
  //   head L(6): fetchCount(L(6)) is 0 until 300 ms after the check of L(5), then 1; not halted
  it('on a testnet, halts when the head is below the first indexed ledger', …);
  //   cfg { network: 'xrpl-testnet', syncStartLedger: L(10) }, commit L(10)..L(20), head L(3): the second message, first L(10)
  it('on a mainnet, waits when the head is below the first indexed ledger', …);   // the same with network 'xrpl': not halted
  // ledger-writer.e2e-spec.ts, in 'committedCheckpoint, storedLedgerHash and missingLedgers'
  it('firstCommittedLedger is undefined on an empty database and the lowest committed ledger after writes', …);
  ```
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-shared build && pnpm --filter @gatehub/data-syncer test:e2e -- live-runner` → FAIL (the boot waits on the checkpoint fetch: the first test times out).
- [ ] **Step 3: Implement** `firstCommittedLedger`, the recorded head below, the due check, the two throws and the boot check; then the three docs (operations: stop `syncer-<slot>`, `api-<slot>` and `exporter-<slot>`; `DROP DATABASE xrpl_testnet` (never a mainnet name); `run --rm migrate-<slot>`; start the syncer and the api; insert the account network names again ([Name an account on one network](operations.md#name-an-account-on-one-network)); the shared database is kept; the explorer deploys the sandbox with a new build id, E7 §11).
- [ ] **Step 4: Run the tests to verify they pass.** `pnpm --filter @gatehub/data-api-shared test:e2e -- ledger-writer`, `pnpm --filter @gatehub/data-syncer test:e2e -- live-runner app`, `pnpm build && pnpm test` → exit 0.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/shared/src/ingest/ingest-state.ts packages/shared/test/ledger-writer.e2e-spec.ts apps/syncer/src/ingest/live-runner.ts \
    apps/syncer/test/live-runner.e2e-spec.ts docs/operations.md docs/troubleshooting.md docs/syncer.md
  git commit -F- <<'EOF'
  feat(syncer): a testnet reset halts the live runner instead of waiting forever

  After a reset the node's head is below the checkpoint and the syncer waited, healthy by every probe.
  Two hashes at one index can only mean another chain, so the runner compares the node's ledger at a
  head below the checkpoint with the stored one and halts (D11); a testnet head below the first indexed
  ledger halts too. A node that is only behind keeps waiting.

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  EOF
  ```

---

### Task 10: The compose files and the sandbox env file

**Files:**
- Modify: `docker-compose.prod.yaml`, `docker-compose.yaml`, `deploy/.env.prod.example`, `apps/api/.env.example`, `apps/syncer/.env.example`, `apps/exporter/.env.example` (the `GH_NETWORK` values), `deploy/nginx/nginx.conf.template` (the comment above the map names the sandbox hosts; nothing else), `docs/configuration.md` (§7: `XRPL_NETWORK`, `XAHAU_NETWORK`, `XRPL_UNL_VALIDATORS`, `XAHAU_UNL_VALIDATORS`, the blank-endpoints and `default` spellings; "Which service gets which variables": no `GH_CLICKHOUSE_DATABASE` from compose, `GH_UNL_VALIDATORS` to the syncers), `docs/deployment.md` ("Environments": production and sandbox, their hosts, one host and ClickHouse server each (D3); the sandbox commands; the certificates: `*.data.gatehub.net` and `*.data.sandbox.gatehub.net`, or the four names, since `*.gatehub.net` covers none of them; exports off without a bucket of the sandbox's own (D14); the topology diagram's note)
- Create: `deploy/.env.sandbox.example`

**Interfaces:**
- Consumes: Task 2 (four names), Task 6 (`default`, `GH_UNL_VALIDATORS`).
- Produces (§10): in both compose files, `GH_NETWORK: ${XRPL_NETWORK:-xrpl}` on `migrate-xrpl`, `syncer-xrpl`, `api-xrpl`, `exporter-xrpl` and `${XAHAU_NETWORK:-xahau}` on the Xahau four, with a comment that the slot serves its family (nginx routes `xrpl.data.*` to it) and every app logs its network at boot; `GH_CLICKHOUSE_DATABASE` removed from them (the profile's `defaultDatabase`); `GH_NODE_ENDPOINTS: ${XRPL_NODE_ENDPOINTS:-}` / `${XAHAU_NODE_ENDPOINTS:-}` on syncers and apis (blank is the profile's default); `GH_UNL_PUBLISHERS: ${XRPL_UNL_PUBLISHERS:-default}` / `${XAHAU_UNL_PUBLISHERS:-default}`; new `GH_UNL_VALIDATORS: ${XRPL_UNL_VALIDATORS:-default}` / `${XAHAU_UNL_VALIDATORS:-default}` on the syncers. `deploy/.env.sandbox.example`: the production example's variables, with the block of §10 (`XRPL_NETWORK=xrpl-testnet`, `XAHAU_NETWORK=xahau-testnet`, the empty endpoint, publisher and validator variables with their comments, empty start ledgers, `GH_EXPORT_BUCKET=` empty = exports off, the sandbox explorer's key in `GH_API_KEYS` and `GH_RATE_LIMIT_KEYS`) and its head comment (§10's two commands). `deploy/.env.prod.example`: commented `# XRPL_NETWORK=xrpl` / `# XAHAU_NETWORK=xahau` lines, and the publisher comment saying empty is `default`.

- [ ] **Step 1: Write the check** (it fails now: the sandbox file is missing and the slots are fixed to mainnet), and pin what the syncer makes of the values compose will send: `syncer.config.spec.ts` `it('resolves the sandbox compose values')` (`GH_NETWORK=xahau-testnet`, `GH_NODE_ENDPOINTS=''`, `GH_UNL_PUBLISHERS=default`, `GH_UNL_VALIDATORS=default`: `nodeEndpoints` `wss://xahau-test.net`, `unlPublishersOf` `[]`, `unlValidatorsOf` the four keys, `unlThresholdOf` 1; it passes already, after Task 6). From the worktree root:
  ```bash
  show() { NPM_TOKEN=unused docker compose -f "$1" --env-file "$2" --profile exports config --format json | node -e '
    const s = JSON.parse(require("fs").readFileSync(0, "utf8")).services;
    for (const n of Object.keys(s).filter((n) => /-(xrpl|xahau)$/.test(n)).sort()) {
      const e = s[n].environment ?? {};
      console.log(n, ["GH_NETWORK", "GH_CLICKHOUSE_DATABASE", "GH_NODE_ENDPOINTS", "GH_UNL_PUBLISHERS", "GH_UNL_VALIDATORS"]
        .map((k) => `${k}=${k in e ? JSON.stringify(e[k]) : "-"}`).join(" "));
    }'; }
  show docker-compose.prod.yaml deploy/.env.sandbox.example
  show docker-compose.prod.yaml deploy/.env.prod.example
  show docker-compose.yaml deploy/.env.sandbox.example
  ```
- [ ] **Step 2: Run it to verify it fails.** The first call fails (`deploy/.env.sandbox.example` does not exist); the second prints `GH_NETWORK="xrpl"` with `GH_CLICKHOUSE_DATABASE="xrpl"` and the spelled-out publishers.
- [ ] **Step 3: Implement** the compose changes, the two env examples, the `.env.example` lines, the nginx comment and the docs.
- [ ] **Step 4: Run it to verify it passes.** Sandbox file, both compose files: every `*-xrpl` service `GH_NETWORK="xrpl-testnet"`, every `*-xahau` `"xahau-testnet"`, `GH_CLICKHOUSE_DATABASE=-`, syncers and apis `GH_NODE_ENDPOINTS=""`, syncers `GH_UNL_PUBLISHERS="default"` and `GH_UNL_VALIDATORS="default"`. Production example: `"xrpl"` / `"xahau"`, `GH_CLICKHOUSE_DATABASE=-`, the example's endpoints, `"default"` for both list variables. `pnpm build && pnpm test` → exit 0.
- [ ] **Step 5: Commit.**
  ```bash
  git add docker-compose.prod.yaml docker-compose.yaml deploy/.env.sandbox.example deploy/.env.prod.example deploy/nginx/nginx.conf.template \
    apps/api/.env.example apps/syncer/.env.example apps/exporter/.env.example apps/syncer/src/config/syncer.config.spec.ts \
    docs/configuration.md docs/deployment.md
  git commit -F- <<'EOF'
  build: the sandbox is the production compose file with deploy/.env.sandbox

  Each slot takes its network from XRPL_NETWORK / XAHAU_NETWORK, and blank endpoints, `default` lists and
  the profile's database leave the testnets' defaults to the profiles; production's env file gets exactly
  what it gets today. The sandbox is its own stack on its own host and ClickHouse server (D3).

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  EOF
  ```

---

### Task 11: ADRs, the remaining docs, the verification and the rollout

**Files:**
- Modify: `docs/adr/0009-one-deployment-per-network.md` (a section "Amendment (2026-10-24): testnets": four profiles, `family` and `kind`, `acceptedNodeNetworkIds`, the testnet databases, the sandbox as its own stack, the reset rule), `docs/adr/0012-validators-and-amendments-data.md` (an amendment: the fixed list, `GH_UNL_VALIDATORS` and the publisher `local`; `retired` on XRPL; the family file on testnets, without its `enabled`), `docs/adr/0010-ripple-v2-wire-compatibility.md` (item 44 gains: "`unl_lists` may name `local`, the fixed list of `GH_UNL_VALIDATORS`."), `docs/api-reference.md` ("Hosts: one per network": rows for XRPL Testnet (`XRP`, CTID 1) and Xahau Testnet (`XAH`, CTID 21338); the production hosts `xrpl.data.gatehub.net`, `xahau.data.gatehub.net` and the sandbox hosts `xrpl.data.sandbox.gatehub.net`, `xahau.data.sandbox.gatehub.net`), `docs/architecture.md` and `docs/development.md` (the four profiles; the files per network (markets, definitions) and per family (amendments); §4's `record:fixtures` and `amendments:check` rows with the four names), `docs/data-model.md` and `docs/clickhouse.md` (the database names `xrpl`, `xahau`, `xrpl_testnet`, `xahau_testnet`; `shared` on each server), `README.md` (the hosts), `GLOSSARY.md` only if a word of this plan is missing there (it already has network, testnet, family, kind, environment, sandbox and the fixed list)

**Interfaces:**
- Consumes: everything above. Produces nothing new for code.

- [ ] **Step 1: Write the docs.** Every number and name copied from the tasks above (and Step 2 of Task 1 for the majority holds, with their source or "not verified").
- [ ] **Step 2: Check the docs against the code.** `pnpm --filter @gatehub/data-api-service test -- api-reference` → PASS; run the "Keeping this page true" script of `docs/configuration.md`: `GH_UNL_VALIDATORS` is printed for the syncer and has its row; `grep -rn "xrpl or xahau\|xrpl|xahau[^|]" docs README.md apps/*/.env.example deploy` finds only text that means the two families.
- [ ] **Step 3: Run the whole verification.**
  ```bash
  pnpm format && git diff --exit-code -- apps packages     # nothing left unformatted
  pnpm build && pnpm test
  pnpm --filter @gatehub/data-api-shared test:e2e
  pnpm --filter @gatehub/data-api-service test:e2e
  pnpm --filter @gatehub/data-syncer test:e2e
  ```
  Every command exits 0.
- [ ] **Step 4: Commit.**
  ```bash
  git add docs README.md
  git commit -F- <<'EOF'
  docs: testnet profiles in ADR-0009, ADR-0012 and ADR-0010 item 44, the hosts and the database names

  The decisions of D-env: four profiles with family and kind, each process accepting only its own node,
  the fixed list as the publisher local, retired on XRPL, the family file on testnets, the reset rule,
  and the sandbox as a stack of its own.

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  EOF
  ```
- [ ] **Step 5: Write the rollout in the task report** (what the owner does; nothing of it is done by the plan):
  1. **Production:** nothing to migrate or reprocess (no migration, no parser version; `xrpl.json`'s retired marks change no mainnet answer). Deploy as usual; compose now leaves the database to the profile (same names). A `xahau` process pointed at a Xahau Testnet node now fails at boot (D10).
  2. **The sandbox:** a host of its own with its own ClickHouse (D3). `cp deploy/.env.sandbox.example deploy/.env.sandbox`, fill in the secrets and the sandbox explorer's key in `GH_API_KEYS` and `GH_RATE_LIMIT_KEYS`, then `docker compose -f docker-compose.prod.yaml --env-file deploy/.env.sandbox up -d --build`. It indexes from the validated head (D4). Certificates for `xrpl.data.sandbox.gatehub.net` and `xahau.data.sandbox.gatehub.net` at the front proxy.
  3. **Inputs:** the testnets' majority holds if Task 1 could not verify them; the name of any amendment ID still unknown after Task 5.
  4. **Then E7:** the explorer's sandbox deploy waits for these hosts to answer (E7 §15).

---

## Rulings

1. **Fields of later sub-projects.** `firstLedger` (D3), `tomlNetworkNames` (D4), `hasDelegation` (D5) and `hasMpt` (D9) are not added here: §1 places each in its own sub-project, which adds its four values to the records of Task 1.
2. **The CTID in the testnet e2e.** The data API serves no CTID (it is an internal key of `util/ctid.ts`), so §17's "`ctid` ends `0001` / `535A`" is pinned on `getTxCtid(…, parseContextFor(profile).networkId)` of every recorded transaction (Task 4).
3. **`live-runner.spec.ts` is the e2e spec.** The runner has no unit harness; §17's live-runner cases go into `apps/syncer/test/live-runner.e2e-spec.ts`, beside "halts at boot when the stored checkpoint hash differs" (Task 9).
4. **`pdf-file.spec.ts` tests `networkLine`.** The exporter has no PDF text reader (`pdf-parse` is the api's devDependency), so the header's network line is an exported pure function, tested for the four names; the api's exports e2e keeps reading `Network: XRP Ledger` from a real PDF (Task 2).
5. **The boot line.** §3's table says "add `kind=testnet` on a testnet"; §10's "every app logs `network=… kind=…`" is read as that line on a testnet. Mainnet lines are unchanged (`networkLogText`, Task 1).
6. **`record:fixtures` checks the node with the profile's accepted ids.** §4 says it refuses a node of another network; its own `networkIdProblem` let a mainnet rippled (no `network_id`) record as `xrpl-testnet`. It now reads `acceptedNodeNetworkIds`, keeping its message (Task 3).
7. **The threshold's bound is the number of lists.** §5 bounds `GH_UNL_THRESHOLD` by `unlListCount`; its message says "the number of lists (<n>)" instead of "publishers", which would be wrong for Xahau Testnet (0 publishers, 1 list) (Task 6).
8. **The domain checker counts the fixed list.** Its own loop takes the masters of the lists in use of the URL publishers (matched by key, which `local`'s `''` never matches); it adds the fixed list's keys, so an unseen fixed-list validator's domain is checked as the directory shows it (Task 7).
9. **Xahau Testnet's names.** The 13 names §6 lists are already in `config/amendments/xahau.json` (checked while planning); only `AB6612F1…FD1EE` needs one, from xahaud's `features.macro` (Task 5).
10. **`default` is a word of the two list variables only.** `MaybeEmptyText` takes it where §2 and §5 give it (`GH_UNL_PUBLISHERS`, `GH_UNL_VALIDATORS`); `GH_NODE_ENDPOINTS` keeps "blank is the default", which compose uses (Tasks 6, 10).
11. **Trust at threshold 1 is tested where it is decided.** §17 names `tally.spec.ts` and `agreement.spec.ts`, but both receive the trusted UNL as a set from `unlAt(context.lists, context.publishers, context.threshold, t)`; the case is in `stored-lists.spec.ts`, over the `ListContext` that now includes `local` (Task 7).
12. **The local list's hash is upper-case hex**, as the `blob_sha256` of a publisher's list is.
