import { EscrowSource, escrowRowOf } from './escrows.job';

/**
 * `escrowRowOf` is pure: the `escrows` row of an escrow from its newest `object_changes` row and its created row. The rows are
 * made by hand (`synthetic-…`), with the field names and the raw values the object changes parser writes (spec section 1.1:
 * drops as text, issued-token and MPT amount objects, Ripple-epoch times); the recorded ledgers are the end-to-end test's.
 */

const ID = 'B95064B1C0D8E5A3F2791AC4E6D3B5F80A1C2E3D4F5A6B7C8D9E0F1A2B3C4D5E';
const OWNER = 'rNeJW71pMjKy42j5jn7vnWZAbmuU6SKs6V';
const DESTINATION = 'rGtW2dWHmHQ3f65pfbjYF5PbFbdZwgwuqW';
const ISSUER = 'rD9ixf7RRUKuKVFTsZa3fZGAN6HtNziPKa';
const RIPPLE_EPOCH = 946_684_800;

/** An MPTokenIssuanceID with the issuer below (the vector of `util/mpt.spec.ts`). */
const MPT_ID = '0000012AB5F762798A53D543A014CAF8B297CFF8F2F937E8';
const MPT_ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';

/** A row of `object_changes` as `escrowRowOf` reads it; `fields` and `event_fields` are given as objects. */
function source(
  over: { ledger_index?: number; action?: EscrowSource['action']; fields?: object; event_fields?: object } = {},
): EscrowSource {
  const { fields = {}, event_fields = {}, ...rest } = over;
  return {
    object_id: ID,
    ledger_index: 107_897_249,
    action: 'created',
    ...rest,
    fields: JSON.stringify({ Account: OWNER, Destination: DESTINATION, Amount: '500000', ...fields }),
    event_fields: JSON.stringify(event_fields),
  };
}

/** The columns of an escrow row that the sentinel owns: they are 0 in an escrow's. */
const NO_TOTAL = { open_count: 0, through_ledger: 0 };

describe('escrowRowOf', () => {
  it('maps a native timed escrow: the drops, the whole units and the times in unix seconds', () => {
    const created = source({
      fields: { FinishAfter: 846_262_201, CancelAfter: 846_265_741, Flags: 0, Sequence: 107_896_555 },
      event_fields: { sequence: 107_896_555 },
    });
    expect(escrowRowOf(created, created, 'XRP', 1_700_000_000_123)).toEqual({
      escrow_id: ID,
      owner: OWNER,
      destination: DESTINATION,
      sequence: 107_896_555,
      currency: 'XRP',
      issuer: '',
      amount: '0.5',
      amount_drops: '500000',
      finish_after: 846_262_201 + RIPPLE_EPOCH,
      cancel_after: 846_265_741 + RIPPLE_EPOCH,
      has_condition: 0,
      created_ledger: 107_897_249,
      last_ledger: 107_897_249,
      deleted: 0,
      ...NO_TOTAL,
      version: 1_700_000_000_123,
    });
  });

  it('takes the native currency of the network and keeps the drops exact', () => {
    const row = escrowRowOf(source({ fields: { Amount: '9007199254740993' } }), undefined, 'XAH', 7);
    expect(row).toMatchObject({
      currency: 'XAH',
      issuer: '',
      amount: '9007199254.740993',
      amount_drops: '9007199254740993',
    });
    expect(escrowRowOf(source({ fields: { Amount: '1' } }), undefined, 'XAH', 7)).toMatchObject({
      amount: '0.000001',
      amount_drops: '1',
    });
  });

  it('leaves a time the escrow does not have null, and sees a Condition', () => {
    const only = (fields: object) => escrowRowOf(source({ fields }), undefined, 'XRP', 1);
    expect(only({ FinishAfter: 100 })).toMatchObject({ finish_after: 100 + RIPPLE_EPOCH, cancel_after: null });
    expect(only({ CancelAfter: 100 })).toMatchObject({ finish_after: null, cancel_after: 100 + RIPPLE_EPOCH });
    expect(only({ Condition: 'A0258020' })).toMatchObject({ has_condition: 1, finish_after: null });
    expect(only({})).toMatchObject({ has_condition: 0 });
  });

  it('maps an issued-token escrow: its currency code (hex kept), issuer and value, and no drops', () => {
    const hex = '5852504C00000000000000000000000000000000';
    const row = escrowRowOf(
      source({
        fields: {
          Amount: { currency: hex, issuer: ISSUER, value: '4258.5' },
          Condition: 'A025802086A17CDDED93ED00ABACFF5A3275B90B043D6E36209353C798AF73DA45D3D1E5810100',
          CancelAfter: 839_949_407,
          FinishAfter: 839_949_392,
        },
      }),
      undefined,
      'XRP',
      3,
    );
    expect(row).toMatchObject({
      currency: hex,
      issuer: ISSUER,
      amount: '4258.5',
      amount_drops: 0,
      has_condition: 1,
      finish_after: 839_949_392 + RIPPLE_EPOCH,
    });
    // a three-letter code is kept as the ledger has it
    expect(
      escrowRowOf(source({ fields: { Amount: { currency: 'USD', issuer: ISSUER, value: '1' } } }), undefined, 'XRP', 3),
    ).toMatchObject({ currency: 'USD', issuer: ISSUER, amount: '1', amount_drops: 0 });
  });

  it('maps an MPT escrow: the issuance ID in upper case is the currency, its issuer is read from it, the units are raw', () => {
    const row = escrowRowOf(
      source({ fields: { Amount: { mpt_issuance_id: MPT_ID.toLowerCase(), value: '2500000' } } }),
      undefined,
      'XRP',
      3,
    );
    expect(row).toMatchObject({ currency: MPT_ID, issuer: MPT_ISSUER, amount: '2500000', amount_drops: 0 });
  });

  it('is deleted when its newest row is a delete, and keeps what the created row says of its start', () => {
    const created = source({ ledger_index: 100, fields: { Sequence: 55 }, event_fields: { sequence: 55 } });
    const finished = source({ ledger_index: 250, action: 'deleted', fields: { Sequence: 55 } });
    expect(escrowRowOf(finished, created, 'XRP', 9)).toMatchObject({
      deleted: 1,
      created_ledger: 100,
      last_ledger: 250,
      sequence: 55,
      amount: '0.5',
      amount_drops: '500000',
    });
    // a modification is not a delete
    expect(escrowRowOf(source({ action: 'modified' }), created, 'XRP', 9)).toMatchObject({ deleted: 0 });
  });

  it('takes the sequence from the created row when the object has none (a ticketed escrow, an old XRPL or a Xahau one)', () => {
    const created = source({ ledger_index: 100, event_fields: { sequence: 99 } });
    const finished = source({ ledger_index: 250, action: 'deleted' });
    expect(escrowRowOf(finished, created, 'XRP', 9)).toMatchObject({ sequence: 99, created_ledger: 100 });
    expect(escrowRowOf(created, created, 'XRP', 9)).toMatchObject({ sequence: 99 });
  });

  it("prefers the object's own Sequence, and has none when neither names one (a Hook-emitted Xahau escrow)", () => {
    const created = source({ ledger_index: 100, event_fields: { sequence: 99 } });
    expect(escrowRowOf(source({ fields: { Sequence: 7 } }), created, 'XRP', 9)).toMatchObject({ sequence: 7 });
    // a 0 is no sequence (the parser leaves it out of the event as well)
    expect(escrowRowOf(source({ fields: { Sequence: 0 } }), created, 'XRP', 9)).toMatchObject({ sequence: 99 });
    const hook = source({ ledger_index: 100, event_fields: {} });
    expect(escrowRowOf(hook, hook, 'XAH', 9)).toMatchObject({ sequence: null, created_ledger: 100 });
    expect(escrowRowOf(hook, undefined, 'XAH', 9)).toMatchObject({ sequence: null, created_ledger: null });
  });

  it('has no created ledger without a created row (history that starts after the escrow was made)', () => {
    const finished = source({ ledger_index: 107_670_360, action: 'deleted' });
    expect(escrowRowOf(finished, undefined, 'XRP', 9)).toMatchObject({
      created_ledger: null,
      last_ledger: 107_670_360,
      deleted: 1,
      sequence: null,
    });
  });

  it('refuses what cannot be mapped, in an error that names the escrow (the job sets such an escrow aside)', () => {
    const refused = (row: EscrowSource, created?: EscrowSource) => () => escrowRowOf(row, created, 'XRP', 1);
    // an Amount of a shape the ledger does not have
    expect(refused(source({ fields: { Amount: { value: '1' } } }))).toThrow(ID);
    expect(refused(source({ fields: { Amount: undefined } }))).toThrow(ID);
    expect(refused(source({ fields: { Amount: '1.5' } }))).toThrow(ID);
    // an MPT amount whose issuance ID is not one: the error of `mptIssuerOf` is named after the escrow too
    expect(refused(source({ fields: { Amount: { mpt_issuance_id: 'ZZ', value: '1' } } }))).toThrow(ID);
    // text that is not JSON, in the newest row and in the created one: the error of `JSON.parse` as well
    expect(refused({ ...source(), fields: '{' })).toThrow(ID);
    expect(refused(source(), { ...source(), event_fields: 'not json' })).toThrow(ID);
  });
});
