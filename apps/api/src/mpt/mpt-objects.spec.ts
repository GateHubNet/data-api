import {
  ACCOUNT_MPT_BODY_KEYS,
  ACCOUNT_MPT_KEYS,
  MPT_FLAGS_KEYS,
  MPT_HOLDER_KEYS,
  MPT_HOLDERS_BODY_KEYS,
  MPT_ISSUANCE_BODY_KEYS,
  MPT_ISSUANCE_KEYS,
  MPT_LOOKUP_BODY_KEYS,
  MPT_SUMMARY_KEYS,
  MPT_TOKEN_CSV_COLUMNS,
  MPT_TOKEN_ROW_KEYS,
  MPT_TOKENS_TOTALS_KEYS,
  MPT_TRANSFER_KEYS,
  MPT_TRANSFER_KINDS,
  MPT_TRANSFERS_BODY_KEYS,
  mptFlags,
  StoredMptIssuance,
  StoredMptTokenRow,
  StoredMptTransfer,
  toAccountMpt,
  toAccountMptCsvRow,
  toMptHolder,
  toMptIssuance,
  toMptSummary,
  toMptTokenCsvRow,
  toMptTokenRow,
  toMptTransfer,
} from './mpt-objects';

const ID = '0000012A9AB7E5A9F3DE1D7F1E8B2C4D5F6A7B8C9D0E1F20';

/** An issuance with every optional column set. */
const FULL: StoredMptIssuance = Object.freeze({
  mpt_issuance_id: ID,
  issuer: 'rIssuer',
  sequence: 298,
  state_known: 1,
  flags: 0x76,
  asset_scale: 2,
  maximum_amount: '5000000000',
  outstanding_amount: '1820451120',
  escrowed_amount: '7',
  locked_amount: '124000000',
  locked_holders: 1,
  holders: 3412,
  transfer_fee: 100,
  metadata_hex: '7B7D',
  metadata: '{"ticker":"HTF","uris":[{"uri":"x"}]}',
  metadata_conforms: 1,
  ticker: 'HTF',
  name: 'Harborline Treasury Fund',
  created_ledger: 99412004,
  created_time: 1_760_008_831,
  created_tx_hash: 'A'.repeat(64),
  last_ledger: 107795512,
  destroyed: 0,
});

/** An issuance with no optional column. */
const BARE: StoredMptIssuance = Object.freeze({
  ...FULL,
  maximum_amount: null,
  metadata_hex: '',
  metadata: '',
  metadata_conforms: 0,
  ticker: '',
  name: '',
  created_ledger: null,
  created_time: null,
  created_tx_hash: null,
});

describe('the key orders', () => {
  it('are the answers of spec 7.2 and 7.5', () => {
    expect(MPT_ISSUANCE_BODY_KEYS).toEqual(['result', 'coverage', 'issuance']);
    expect(MPT_LOOKUP_BODY_KEYS).toEqual(['result', 'count', 'issuances']);
    expect(MPT_FLAGS_KEYS).toEqual([
      'locked',
      'can_lock',
      'require_auth',
      'can_escrow',
      'can_trade',
      'can_transfer',
      'can_clawback',
    ]);
  });
});

describe('mptFlags', () => {
  it('names every bit of the raw UInt32', () => {
    expect(Object.values(mptFlags(0x7f))).toEqual(Array(7).fill(true));
    expect(Object.keys(mptFlags(0x7f))).toEqual([...MPT_FLAGS_KEYS]);
    expect(mptFlags(0x22)).toEqual({
      locked: false,
      can_lock: true,
      require_auth: false,
      can_escrow: false,
      can_trade: false,
      can_transfer: true,
      can_clawback: false,
    });
    expect(Object.values(mptFlags(0))).toEqual(Array(7).fill(false));
  });

  it.each([
    [0x01, 'locked'],
    [0x02, 'can_lock'],
    [0x04, 'require_auth'],
    [0x08, 'can_escrow'],
    [0x10, 'can_trade'],
    [0x20, 'can_transfer'],
    [0x40, 'can_clawback'],
  ])('reads %i as %s alone', (bit, name) => {
    const flags = mptFlags(bit);
    expect(Object.entries(flags).filter(([, on]) => on)).toEqual([[name, true]]);
  });

  it('ignores a bit it does not know', () => {
    expect(Object.values(mptFlags(0x80))).toEqual(Array(7).fill(false));
  });
});

describe('toMptIssuance', () => {
  it('has the keys of MPT_ISSUANCE_KEYS in order', () => {
    expect(Object.keys(toMptIssuance(FULL))).toEqual([...MPT_ISSUANCE_KEYS]);
  });

  it('serves the values: the time, the flags, the metadata parsed, booleans for the flags of a row', () => {
    expect(toMptIssuance(FULL)).toMatchObject({
      metadata: { ticker: 'HTF', uris: [{ uri: 'x' }] },
      metadata_hex: '7B7D',
      metadata_conforms: true,
      created_ledger: 99412004,
      created_time: '2025-10-09T11:20:31Z',
      destroyed: false,
      flags: { can_lock: true, locked: false, can_clawback: true },
      locked_holders: 1,
      holders: 3412,
    });
    expect(toMptIssuance({ ...FULL, destroyed: 1 }).destroyed).toBe(true);
  });

  it('leaves out a key with no value, and never serves null', () => {
    const bare = toMptIssuance(BARE);
    expect(Object.keys(bare)).toEqual(
      MPT_ISSUANCE_KEYS.filter(
        (key) =>
          ![
            'ticker',
            'name',
            'maximum_amount',
            'metadata',
            'metadata_hex',
            'metadata_conforms',
            'created_ledger',
            'created_time',
            'created_tx_hash',
          ].includes(key),
      ),
    );
    expect(Object.values(bare)).not.toContain(null);
  });

  it('serves metadata_hex without metadata', () => {
    const raw = toMptIssuance({ ...BARE, metadata_hex: 'DEADBEEF', metadata_conforms: 0 });
    expect(raw).not.toHaveProperty('metadata');
    expect(raw).toMatchObject({ metadata_hex: 'DEADBEEF', metadata_conforms: false });
  });

  it('keeps an amount digit for digit', () => {
    const big = toMptIssuance({
      ...FULL,
      maximum_amount: '9223372036854775807',
      outstanding_amount: '9223372036854775807',
      escrowed_amount: '9007199254740993',
      locked_amount: '9007199254740993',
    });
    expect(big).toMatchObject({
      maximum_amount: '9223372036854775807',
      outstanding_amount: '9223372036854775807',
      escrowed_amount: '9007199254740993',
      locked_amount: '9007199254740993',
    });
  });
});

describe('toMptSummary', () => {
  it('has the keys of MPT_SUMMARY_KEYS in order', () => {
    expect(Object.keys(toMptSummary(FULL))).toEqual([...MPT_SUMMARY_KEYS]);
  });

  it('leaves out a key with no value', () => {
    const bare = toMptSummary(BARE);
    expect(Object.keys(bare)).toEqual(
      MPT_SUMMARY_KEYS.filter((key) => !['ticker', 'name', 'maximum_amount'].includes(key)),
    );
    expect(bare).toMatchObject({ outstanding_amount: '1820451120', holders: 3412, destroyed: false });
  });
});

describe('toMptHolder', () => {
  const ROW = { holder: 'rHolder', amount_text: '9007199254740993', escrowed_text: '7', flags: 0 };

  it('has the keys of MPT_HOLDER_KEYS in order, and the amounts digit for digit', () => {
    expect(MPT_HOLDERS_BODY_KEYS).toEqual(['result', 'coverage', 'count', 'marker', 'holders']);
    const holder = toMptHolder(ROW, 0);
    expect(Object.keys(holder)).toEqual([...MPT_HOLDER_KEYS]);
    expect(holder).toEqual({
      holder: 'rHolder',
      amount: '9007199254740993',
      escrowed_amount: '7',
      locked: false,
      authorized: false,
    });
  });

  it('is locked by its own flag or by the issuance, and authorized by its own', () => {
    expect(toMptHolder({ ...ROW, flags: 0x01 }, 0).locked).toBe(true);
    expect(toMptHolder(ROW, 0x01).locked).toBe(true);
    // the issuance's other bits say nothing of a balance
    expect(toMptHolder(ROW, 0x7e).locked).toBe(false);
    expect(toMptHolder({ ...ROW, flags: 0x02 }, 0)).toMatchObject({ locked: false, authorized: true });
    expect(toMptHolder(ROW, 0x7f).authorized).toBe(false);
  });
});

describe('toMptTransfer', () => {
  const ROW: StoredMptTransfer = {
    ledger_index: 107795410,
    tx_index: 31,
    tx_hash: 'A'.repeat(64),
    close_unix: 1_792_850_000,
    tx_type: 'Payment',
    kind: 'payment',
    source: 'rSource',
    destination: 'rDestination',
    amount_text: '2500000',
    fee_text: '25',
  };

  it('has the keys of MPT_TRANSFER_KEYS in order', () => {
    expect(MPT_TRANSFERS_BODY_KEYS).toEqual(['result', 'coverage', 'count', 'marker', 'transfers']);
    expect(Object.keys(toMptTransfer(ROW))).toEqual([...MPT_TRANSFER_KEYS]);
    expect(toMptTransfer(ROW)).toMatchObject({ executed_time: '2026-10-24T13:53:20Z', amount: '2500000', fee: '25' });
  });

  it('leaves out an empty source or destination, and a fee of 0', () => {
    const bare = toMptTransfer({ ...ROW, source: '', destination: '', fee_text: '0' });
    expect(Object.keys(bare)).toEqual(
      MPT_TRANSFER_KEYS.filter((key) => !['source', 'destination', 'fee'].includes(key)),
    );
  });

  it('lists the kinds in the order of the message', () => {
    expect(MPT_TRANSFER_KINDS).toEqual([
      'payment',
      'clawback',
      'lock',
      'unlock',
      'escrow_create',
      'escrow_finish',
      'escrow_cancel',
    ]);
  });
});

describe('toMptTokenRow', () => {
  const ROW: StoredMptTokenRow = {
    rank: 3,
    mpt_issuance_id: ID,
    issuer: 'rIssuer',
    ticker: 'HTF',
    name: 'Harborline Treasury Fund',
    asset_scale: 2,
    maximum_text: '9223372036854775807',
    outstanding_text: '1820451120',
    holders: 3412,
    transfer_fee: 100,
    flags: 0x22,
  };

  it('has the keys of MPT_TOKEN_ROW_KEYS in order', () => {
    expect(MPT_TOKENS_TOTALS_KEYS).toEqual(['issuances', 'holders', 'transfers_24h']);
    const row = toMptTokenRow(ROW, 412);
    expect(Object.keys(row)).toEqual([...MPT_TOKEN_ROW_KEYS]);
    expect(row).toMatchObject({
      rank: 3,
      maximum_amount: '9223372036854775807',
      outstanding_amount: '1820451120',
      flags: { can_lock: true, can_transfer: true, locked: false },
      transfers_24h: 412,
    });
  });

  it('leaves out a key with no value', () => {
    const row = toMptTokenRow({ ...ROW, ticker: '', name: '', maximum_text: null }, 0);
    expect(Object.keys(row)).toEqual(
      MPT_TOKEN_ROW_KEYS.filter((key) => !['ticker', 'name', 'maximum_amount'].includes(key)),
    );
    expect(row.transfers_24h).toBe(0);
  });

  it('keeps what an issuer wrote from running in a spreadsheet, in the CSV only', () => {
    const row = toMptTokenRow({ ...ROW, ticker: '@SUM', name: '=HYPERLINK("http://x/","Fund")' }, 0);
    expect(toMptTokenCsvRow(row)).toMatchObject({ ticker: "'@SUM", name: "'=HYPERLINK('http://x/','Fund')" });
    expect(row).toMatchObject({ ticker: '@SUM', name: '=HYPERLINK("http://x/","Fund")' });
  });

  it('keeps what an issuer wrote from running in a spreadsheet in a holding too', () => {
    const cells = toAccountMptCsvRow({ mpt_issuance_id: ID, ticker: '+1', name: 'a"b', amount: '1' });
    expect(cells).toMatchObject({ mpt_issuance_id: ID, ticker: "'+1", name: "a'b", amount: '1' });
  });

  it('has the same columns in the CSV whatever a row holds, its flags flattened and an empty cell for what is absent', () => {
    const bare = toMptTokenCsvRow(toMptTokenRow({ ...ROW, ticker: '', name: '', maximum_text: null }, 0));
    expect(Object.keys(bare)).toEqual([...MPT_TOKEN_CSV_COLUMNS]);
    expect(bare).toMatchObject({
      ticker: null,
      name: null,
      maximum_amount: null,
      'flags.can_lock': true,
      transfers_24h: 0,
    });
    expect(MPT_TOKEN_CSV_COLUMNS).toEqual([
      'rank',
      'mpt_issuance_id',
      'issuer',
      'ticker',
      'name',
      'asset_scale',
      'maximum_amount',
      'outstanding_amount',
      'holders',
      'transfer_fee',
      'flags.locked',
      'flags.can_lock',
      'flags.require_auth',
      'flags.can_escrow',
      'flags.can_trade',
      'flags.can_transfer',
      'flags.can_clawback',
      'transfers_24h',
    ]);
  });
});

describe('toAccountMpt', () => {
  const HOLDING = {
    mpt_issuance_id: '0598F6E09E30A809E63A1F02DE789586D2F4FDA9EF5200E3',
    amount_text: '9007199254740993',
    escrowed_text: '7',
    flags: 0x02,
  };
  const ISSUANCE: StoredMptIssuance = { ...FULL, flags: 0 };

  it("has the keys of ACCOUNT_MPT_KEYS in order, with the issuance's fields, the amounts digit for digit", () => {
    expect(ACCOUNT_MPT_BODY_KEYS).toEqual([
      'result',
      'coverage',
      'ledger_index',
      'close_time',
      'count',
      'marker',
      'mpt',
    ]);
    const holding = toAccountMpt(HOLDING, ISSUANCE);
    expect(Object.keys(holding)).toEqual([...ACCOUNT_MPT_KEYS]);
    expect(holding).toEqual({
      mpt_issuance_id: HOLDING.mpt_issuance_id,
      // from the ID, whatever the row says
      issuer: 'rERShrtUSEXkrwtTpugPV4v8E787vpx1kb',
      ticker: 'HTF',
      name: 'Harborline Treasury Fund',
      asset_scale: 2,
      amount: '9007199254740993',
      escrowed_amount: '7',
      locked: false,
      authorized: true,
    });
  });

  it('has only what the ID and the state say of an issuance with no row or no known state', () => {
    const keys = ['mpt_issuance_id', 'issuer', 'amount', 'escrowed_amount', 'locked', 'authorized'];
    expect(Object.keys(toAccountMpt(HOLDING, undefined))).toEqual(keys);
    expect(Object.keys(toAccountMpt(HOLDING, { ...ISSUANCE, state_known: 0 }))).toEqual(keys);
  });

  it('leaves out an empty ticker and name, and keeps an asset_scale of 0', () => {
    const holding = toAccountMpt(HOLDING, { ...ISSUANCE, ticker: '', name: '', asset_scale: 0 });
    expect(Object.keys(holding)).toEqual(ACCOUNT_MPT_KEYS.filter((key) => !['ticker', 'name'].includes(key)));
    expect(holding.asset_scale).toBe(0);
  });

  it('is locked by its own flag or by the issuance', () => {
    expect(toAccountMpt({ ...HOLDING, flags: 0x01 }, ISSUANCE).locked).toBe(true);
    expect(toAccountMpt(HOLDING, { ...ISSUANCE, flags: 0x01 }).locked).toBe(true);
    expect(toAccountMpt(HOLDING, undefined).locked).toBe(false);
  });
});
