import {
  AccountExchangesRow,
  AccountPaymentsRow,
  AccountsCreatedRow,
  AccountTransactionsRow,
  AccountTxBySequenceRow,
  AggDirtyRow,
  AmendmentFeaturesRow,
  AmendmentTalliesRow,
  BalanceChangesRow,
  ExchangesRow,
  FeeStatsRow,
  IngestLogRow,
  LedgerByHashRow,
  LedgersRow,
  NetworkStateRow,
  PARSER_VERSION,
  PaymentsByCurrencyRow,
  PaymentsRow,
  StatsHourlyRow,
  SyncerLeaseRow,
  TransactionsRow,
  TxByHashRow,
  TxByTypeRow,
  UnlListsRow,
  UnlPublishersRow,
  ValidationsRow,
  ValidatorAgreementHourlyRow,
  ValidatorDomainsRow,
  ValidatorManifestsRow,
  ValidatorSeenRow,
  ValidatorValidationsRow,
  ValidatorVotesRow,
  VolumeDailyRow,
  VolumeLiveRow,
} from '../src/clickhouse/rows';
import { Table } from '../src/clickhouse/tables';

/** The row type of each table. Typing the samples with it makes a missing or extra field a compile error. */
export interface TableRows {
  [Table.Ledgers]: LedgersRow;
  [Table.LedgerByHash]: LedgerByHashRow;
  [Table.Transactions]: TransactionsRow;
  [Table.TxByHash]: TxByHashRow;
  [Table.TxByType]: TxByTypeRow;
  [Table.AccountTransactions]: AccountTransactionsRow;
  [Table.AccountTxBySequence]: AccountTxBySequenceRow;
  [Table.Payments]: PaymentsRow;
  [Table.PaymentsByCurrency]: PaymentsByCurrencyRow;
  [Table.AccountPayments]: AccountPaymentsRow;
  [Table.Exchanges]: ExchangesRow;
  [Table.AccountExchanges]: AccountExchangesRow;
  [Table.BalanceChanges]: BalanceChangesRow;
  [Table.AccountsCreated]: AccountsCreatedRow;
  [Table.FeeStats]: FeeStatsRow;
  [Table.Validations]: ValidationsRow;
  [Table.ValidatorManifests]: ValidatorManifestsRow;
  [Table.ValidatorValidations]: ValidatorValidationsRow;
  [Table.ValidatorSeen]: ValidatorSeenRow;
  [Table.UnlLists]: UnlListsRow;
  [Table.UnlPublishers]: UnlPublishersRow;
  [Table.ValidatorDomains]: ValidatorDomainsRow;
  [Table.NetworkState]: NetworkStateRow;
  [Table.AmendmentFeatures]: AmendmentFeaturesRow;
  [Table.ValidatorVotes]: ValidatorVotesRow;
  [Table.AmendmentTallies]: AmendmentTalliesRow;
  [Table.ValidatorAgreementHourly]: ValidatorAgreementHourlyRow;
  [Table.StatsHourly]: StatsHourlyRow;
  [Table.VolumeDaily]: VolumeDailyRow;
  [Table.VolumeLive]: VolumeLiveRow;
  [Table.IngestLog]: IngestLogRow;
  [Table.AggDirty]: AggDirtyRow;
  [Table.SyncerLease]: SyncerLeaseRow;
}

const hash = (n: number): string => n.toString(16).toUpperCase().padStart(64, '0');

const LEDGER = 80_000_001;
const CLOSE = 1_700_000_000;
const CLOSE_MS = 1_700_000_000.123;
/**
 * Midday UTC today: `validations` expires rows 90 days after `last_datetime` (an older row is gone as soon as it is
 * written) and is partitioned by day, so its samples need a recent time that is far from a day boundary.
 */
export const TODAY_NOON = Math.floor(Date.now() / 86_400_000) * 86_400 + 43_200;
/** A rippled 2.3.0 release as `encodeSoftwareVersion` packs it: above 2^53, so it is a string. */
const SERVER_VERSION = '1745991492456939520';
/** Wall-clock milliseconds, as the `version` of a version set. */
const VERSION_MS = 1_700_000_000_123;
const ISSUER = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
const ALICE = 'rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn';
const BOB = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';

const exchange: ExchangesRow = {
  base_currency: 'XRP',
  base_issuer: '',
  counter_currency: 'USD',
  counter_issuer: ISSUER,
  ledger_index: LEDGER,
  tx_index: 1,
  node_index: 4,
  tx_hash: hash(11),
  close_time: CLOSE,
  base_amount: '100',
  counter_amount: '52.5',
  base_amount_f: 100,
  counter_amount_f: 52.5,
  rate: '0.525',
  rate_f: 0.525,
  buyer: ALICE,
  seller: BOB,
  taker: ALICE,
  provider: BOB,
  offer_sequence: 77,
  autobridged_currency: 'EUR',
  autobridged_issuer: ISSUER,
  tx_type: 'OfferCreate',
  client: 'xumm',
};

/** One distinct value per column of every table, in the shape the row interfaces describe. */
export const SAMPLE_ROWS: { [T in Table]: TableRows[T] } = {
  [Table.Ledgers]: {
    ledger_index: LEDGER,
    ledger_hash: hash(1),
    parent_hash: hash(2),
    account_hash: hash(3),
    transaction_hash: hash(4),
    total_coins: '99987654321098765',
    close_time: CLOSE,
    parent_close_time: CLOSE - 4,
    close_time_resolution: 10,
    close_flags: 1,
    tx_count: 3,
    type_counts: { Payment: 2, OfferCreate: 1 },
    result_counts: { tesSUCCESS: 3 },
    payments_count: 2,
    exchanges_count: 1,
    accounts_created: 1,
    fee_total: 36,
    fee_min: 10,
    fee_max: 16,
    parser_version: PARSER_VERSION,
    ingested_at: CLOSE + 100,
  },
  [Table.LedgerByHash]: { ledger_hash: hash(1), ledger_index: LEDGER },
  [Table.Transactions]: {
    ledger_index: LEDGER,
    tx_index: 1,
    hash: hash(11),
    tx_type: 'OfferCreate',
    result: 'tesSUCCESS',
    account: ALICE,
    sequence: 41,
    fee: 12,
    close_time: CLOSE,
    tx_json: '{"TransactionType":"OfferCreate"}',
    meta_json: '{"TransactionResult":"tesSUCCESS"}',
  },
  [Table.TxByHash]: { hash: hash(11), ledger_index: LEDGER, tx_index: 1 },
  [Table.TxByType]: { tx_type: 'OfferCreate', ledger_index: LEDGER, tx_index: 1, result: 'tesSUCCESS' },
  [Table.AccountTransactions]: {
    account: ALICE,
    ledger_index: LEDGER,
    tx_index: 1,
    tx_type: 'OfferCreate',
    result: 'tesSUCCESS',
    is_initiator: 1,
    close_time: CLOSE,
  },
  [Table.AccountTxBySequence]: { account: ALICE, sequence: 41, ledger_index: LEDGER, tx_index: 1 },
  [Table.Payments]: {
    ledger_index: LEDGER,
    tx_index: 0,
    tx_hash: hash(10),
    close_time: CLOSE,
    source: ALICE,
    destination: BOB,
    currency: 'USD',
    issuer: ISSUER,
    amount: '25.5',
    delivered_amount: '25.4',
    delivered_amount_f: 25.4,
    max_amount: '26',
    source_currency: 'EUR',
    source_tag: 7,
    destination_tag: 9,
    invoice_id: hash(99),
    fee: 12,
    source_balance_changes: '[{"currency":"EUR"}]',
    destination_balance_changes: '[{"currency":"USD"}]',
    client: 'xumm',
  },
  [Table.PaymentsByCurrency]: { currency: 'USD', issuer: ISSUER, ledger_index: LEDGER, tx_index: 0 },
  [Table.AccountPayments]: {
    account: ALICE,
    ledger_index: LEDGER,
    tx_index: 0,
    tx_hash: hash(10),
    close_time: CLOSE,
    direction: 'sent',
    counterparty: BOB,
    currency: 'USD',
    issuer: ISSUER,
    delivered_amount: '25.4',
    delivered_amount_f: 25.4,
    source_tag: 7,
    destination_tag: 9,
  },
  [Table.Exchanges]: exchange,
  [Table.AccountExchanges]: { ...exchange, account: BOB },
  [Table.BalanceChanges]: {
    account: ALICE,
    ledger_index: LEDGER,
    tx_index: 0,
    node_index: -1,
    tx_hash: hash(10),
    close_time: CLOSE,
    currency: 'XRP',
    counterparty: '',
    amount_change: '-12',
    final_balance: '9999988',
    final_balance_f: 9999988,
    change_type: 'transaction_cost',
    escrow_counterparty: BOB,
    escrow_balance_change: '-5',
    paychannel_counterparty: BOB,
    paychannel_fund_change: '3',
    paychannel_fund_final_balance: '30',
    paychannel_final_balance: '20',
    paychannel_balance_change: '2',
    client: 'xumm',
  },
  [Table.AccountsCreated]: {
    account: BOB,
    parent: ALICE,
    initial_balance: '20000000',
    ledger_index: LEDGER,
    tx_index: 0,
    tx_hash: hash(10),
    inception: CLOSE,
    genesis_balance: '100000000',
    genesis_index: 32570,
  },
  [Table.FeeStats]: {
    ts: CLOSE_MS,
    current_ledger_size: 12,
    expected_ledger_size: 30,
    current_queue_size: 2,
    max_queue_size: 2000,
    pct_max_queue_size: 0.1,
    median_fee: 5000,
    minimum_fee: 10,
    open_ledger_fee: 10,
  },
  [Table.Validations]: {
    ledger_hash: hash(1),
    validation_public_key: 'n9KDJnd',
    count: 1,
    first_datetime: TODAY_NOON + 0.123,
    last_datetime: TODAY_NOON + 0.123,
    ledger_index: LEDGER,
    reporter_public_key: 'n9reporter',
    ephemeral_public_key: 'n9ephemeral',
    signature: 'ABCDEF',
    signing_time: 750_000_000,
    flags: 2147483649,
    full: 1,
    amendments: 'AMENDMENT1,AMENDMENT2',
    base_fee: 10,
    load_fee: 256,
    reserve_base: 10_000_000,
    reserve_inc: 2_000_000,
    server_version: SERVER_VERSION,
  },
  [Table.ValidatorManifests]: {
    ephemeral_key: 'n9ephemeral',
    master_key: 'nHmaster',
    seq: 5,
    domain: 'validator.example',
    manifest: 'ABCDEF0123456789',
    source: 'rpc',
  },
  // validator_validations expires 7 days after last_datetime, network_state 100 days after polled_at and the hourly
  // agreement 400 days after its hour: their samples are recent. A DateTime64(3) sample ends in .125, .375, .625 or
  // .875: a double holds those exactly and ClickHouse prints three decimals, so the round trip compares equal as text.
  [Table.ValidatorValidations]: {
    validation_public_key: 'nHmaster',
    ledger_index: LEDGER,
    ledger_hash: hash(1),
    count: 2,
    first_datetime: TODAY_NOON + 0.125,
    last_datetime: TODAY_NOON + 0.875,
    ephemeral_public_key: 'n9ephemeral',
    signing_time: 750_000_000,
    full: 1,
    server_version: SERVER_VERSION,
  },
  [Table.ValidatorSeen]: {
    validation_public_key: 'nHmaster',
    first_seen: 1_699_000_000.125,
    last_seen: 1_700_000_000.875,
    last_ledger_index: LEDGER,
  },
  [Table.UnlLists]: {
    publisher: 'vl.example',
    publisher_key: 'ED' + '0'.repeat(64),
    sequence: 2026070302,
    version: 1,
    effective: CLOSE - 3_600,
    expiration: CLOSE + 86_400,
    validators: ['nHmaster', 'nHother'],
    blob_sha256: hash(21).toLowerCase(),
    fetched_at: CLOSE_MS,
    response: '{"version":1,"blob":"e30="}',
  },
  [Table.UnlPublishers]: {
    publisher: 'vl.example',
    url: 'https://vl.example',
    publisher_key: 'ED' + '0'.repeat(64),
    configured: 1,
    threshold: 1,
    checked_at: CLOSE_MS,
    status: 'error',
    error: 'timeout',
    last_ok_at: 1_699_999_400.625,
  },
  [Table.ValidatorDomains]: {
    validation_public_key: 'nHmaster',
    domain: 'validator.example',
    status: 'verified',
    reason: '',
    status_code: 0,
    toml_url: 'https://validator.example/.well-known/xrp-ledger.toml',
    checked_at: CLOSE_MS,
    verified_at: 1_699_999_990.375,
    next_check_at: CLOSE + 3_600,
    accounts: [ALICE, BOB],
  },
  [Table.NetworkState]: {
    ledger_index: LEDGER,
    ledger_hash: hash(1),
    polled_at: TODAY_NOON + 0.125,
    amendments: [hash(31), hash(32)],
    majorities: [{ amendment: hash(33), since: CLOSE }],
    negative_unl: [{ validation_public_key: 'nHdisabled', first_ledger: LEDGER - 100 }],
    to_disable: 'nHtodisable',
    to_reenable: 'nHtoreenable',
    base_fee: 10,
    reserve_base: 10_000_000,
    reserve_inc: 2_000_000,
    node_quorum: 28,
  },
  [Table.AmendmentFeatures]: { amendment_id: hash(31), name: 'AMM', supported: 1, polled_at: CLOSE_MS },
  [Table.ValidatorVotes]: {
    ledger_index: LEDGER,
    validation_public_key: 'nHmaster',
    ledger_hash: hash(1),
    close_time: CLOSE,
    full: 1,
    amendments: [hash(31), hash(32)],
    base_fee: 10,
    reserve_base: 10_000_000,
    reserve_inc: 2_000_000,
    server_version: SERVER_VERSION,
    version: VERSION_MS,
  },
  [Table.AmendmentTallies]: {
    ledger_index: LEDGER,
    amendment_id: hash(31),
    close_time: CLOSE,
    yes: 28,
    trusted: 35,
    threshold: 28,
    unl_size: 35,
    observed: 34,
    unl: ['nHmaster', 'nHother'],
    negative_unl: ['nHdisabled'],
    base_fee: 10,
    reserve_base: 10_000_000,
    reserve_inc: 2_000_000,
    version: VERSION_MS,
  },
  [Table.ValidatorAgreementHourly]: {
    hour: TODAY_NOON - 43_200,
    validation_public_key: 'nHmaster',
    agreed: 900,
    missed: 3,
    partial: 1,
    last_seen: TODAY_NOON - 40_000 + 0.875,
    ledgers: 1_000,
    unobserved: 2,
    gaps: 1,
    unl_size: 35,
    quorum: 28,
    final: 1,
    version: VERSION_MS,
  },
  [Table.StatsHourly]: {
    hour: 1_699_999_200,
    transaction_count: 300,
    payments_count: 200,
    exchanges_count: 100,
    accounts_created: 4,
    ledger_count: 900,
    first_close_time: 1_699_999_200,
    last_close_time: 1_700_002_799,
    type_counts: { Payment: 200, OfferCreate: 100 },
    result_counts: { tesSUCCESS: 290, tecPATH_DRY: 10 },
    version: 1,
  },
  [Table.VolumeDaily]: {
    metric: 'exchange_volume',
    day: '2023-11-14',
    component: 'USD+' + ISSUER,
    base_currency: 'XRP',
    base_issuer: '',
    counter_currency: 'USD',
    counter_issuer: ISSUER,
    amount: '1000.5',
    amount_f: 1000.5,
    count: 12,
    rate_f: 0.5,
    converted_f: 500.25,
    config_version: 3,
    version: 1,
  },
  [Table.VolumeLive]: {
    metric: 'exchange_volume',
    period: 'day',
    start_time: CLOSE - 86_400,
    end_time: CLOSE,
    component: 'USD+' + ISSUER,
    base_currency: 'XRP',
    base_issuer: '',
    counter_currency: 'USD',
    counter_issuer: ISSUER,
    amount: '1000.5',
    amount_f: 1000.5,
    count: 12,
    rate_f: 0.5,
    converted_f: 500.25,
    config_version: 3,
    version: 1,
  },
  [Table.IngestLog]: { range_start: 100, range_end: 199, run_id: 'run-1', status: 'done', updated_at: CLOSE_MS },
  [Table.AggDirty]: { from_hour: 1_699_999_200, to_hour: 1_700_002_800, created_at: CLOSE_MS },
  [Table.SyncerLease]: { network: 'xrpl', holder: 'syncer-1', heartbeat: CLOSE_MS },
};
