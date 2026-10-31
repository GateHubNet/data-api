import {
  MPT_FLAGS_KEYS,
  MPT_ISSUANCE_BODY_KEYS,
  MPT_ISSUANCE_KEYS,
  MPT_LOOKUP_BODY_KEYS,
  MPT_SUMMARY_KEYS,
  mptFlags,
  StoredMptIssuance,
  toMptIssuance,
  toMptSummary,
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
