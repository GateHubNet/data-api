import { join } from 'path';
import { FixtureLedgerSource } from '../ingest/fixture-ledger-source';
import { RawLedger, RawTransaction } from '../ingest/raw-ledger';
import { deepFreeze } from '../test-utils/deep-freeze';
import { DestinationTagParser, MAX_DESTINATION_TAG, ParsedDestinationTag } from './destination-tag.parser';
import { ParserTx, toParserTx } from './parser.interface';

type Json = Record<string, any>;

const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures');

const parser = new DestinationTagParser();

const setCache = new Map<string, RawLedger[]>();

/** Every ledger of a fixture directory (`xrpl/recorded`...), loaded once. */
function ledgersOf(dir: string): RawLedger[] {
  if (!setCache.has(dir)) setCache.set(dir, FixtureLedgerSource.fromDir(join(FIXTURES, dir)).list());
  return setCache.get(dir)!;
}

/** A recorded transaction by its hash in a fixture directory, deep-frozen. */
function recordedTx(dir: string, hash: string): ParserTx {
  for (const ledger of ledgersOf(dir)) {
    const tx: RawTransaction | undefined = ledger.transactions.find((t) => t.hash === hash);
    if (tx) return deepFreeze(toParserTx(tx, ledger.header, null));
  }
  throw new Error(`${dir} has no transaction ${hash}`);
}

/** A synthetic edit of a recorded transaction: its `tx` with `edit` applied, deep-frozen. */
const edited = (t: ParserTx, edit: Json): ParserTx => deepFreeze({ ...t, tx: { ...t.tx, ...edit } });

/** The recorded payment of `xrpl/recorded` (ledger 107670360), tagged 19593017: the source of most synthetic edits. */
const PAYMENT = ['xrpl/recorded', '48C09512C3220E6429BB3EC905D48AE75DB5835B86CB76210FA16AD6BC61AC50'] as const;

/** Recorded transactions with a tag, each with its ledger and what the parser reads from it. */
const TAGGED: Array<[string, string, string, number, ParsedDestinationTag]> = [
  [
    'a payment',
    'xrpl/recorded',
    PAYMENT[1],
    107_670_360,
    { destination: 'rUSyqwqFFYL6RJysH9o5RWNC4b8TiDJsQj', destination_tag: 19_593_017 },
  ],
  [
    'tag 0',
    'xrpl/recorded',
    '6E887595D351A5A024F50D3FD438C09740C1183A5F30BC60692D1547866B768E',
    107_671_538,
    { destination: 'rG2TJM93MdgCNCSMgCxuW47oDFsXK2RyZS', destination_tag: 0 },
  ],
  [
    'a failed payment (tecPATH_DRY)',
    'xrpl/account-state',
    '851ADEFC847D0490E43FD4BC570D57026998FB7FF0AA061AB32E2E2F0DA7A18B',
    93_663_329,
    { destination: 'rH98Tr1c7W4rctaLwEg9xkq64p9E8BWcDM', destination_tag: 1 },
  ],
  [
    'a Batch inner payment (Flags 0x40030000)',
    'xrpl/account-state',
    '3ACCA401077894B79867C792345866944C6928D58FC6AA41BB16223DDC2C76D0',
    107_872_956,
    { destination: 'r9ruWAaX3E4EDrMWgs7A7QbcvooMnHkaUd', destination_tag: 0 },
  ],
  [
    "Xahau's Remit",
    'xahau/uritoken',
    '3D9B20E130D7498E98FB3499BD4C2AC4CCDB3D11FFBFEA8F9B7FB844DDF33426',
    26_689_211,
    { destination: 'r9gvUQxtV98nRAM26aknj4h6RXKyXCLMVS', destination_tag: 0 },
  ],
];

/** Recorded transactions with a `Destination` and no tag: the sources of the synthetic edits by type. */
const UNTAGGED: Array<[string, string, string]> = [
  ['escrow_create_timed', 'xrpl/objects', 'BF93E9B72AE372BCEB27781CA58C4ABE7E51EE9F5D254D02B83C92EC1A22AE53'],
  ['check_create_xrp', 'xrpl/objects', 'DE0C4334780CE8115BCCB7E41371B85D13D284F82F48EFB98BE8D2F894207E0E'],
  ['channel_create', 'xrpl/objects', '04BF7DE957E5E2EE8BB67EF00CEB2EFF7A72496FAED3442CA9680E8ECF2EAFB7'],
  ['account_delete', 'xrpl/account-state', '8F2DCA944394B29981E24DDD6C46192C404D90F7F5FC4EAB6813B0AFD7751A2D'],
  ['a Xahau Invoke', 'xahau/objects', '107488C4A74D3315CC4CA4142F685B4148837CAE62179D27806CF6480D60F6FB'],
];

describe('DestinationTagParser', () => {
  it.each(TAGGED)('reads the tag of %s', (_name, dir, hash, ledger, expected) => {
    const t = recordedTx(dir, hash);
    expect(t.ledger_index).toBe(ledger);
    expect(parser.parse(t)).toEqual(expected);
  });

  it('names recorded cases that are what they say: a tecPATH_DRY, a Batch inner payment and a Remit', () => {
    // So the cases above pin that the rule skips nothing by its result, its flags or its type.
    expect(recordedTx('xrpl/account-state', TAGGED[2][2]).meta.TransactionResult).toBe('tecPATH_DRY');
    expect(recordedTx('xrpl/account-state', TAGGED[3][2]).tx.Flags).toBe(0x40030000);
    expect(recordedTx('xahau/uritoken', TAGGED[4][2]).tx.TransactionType).toBe('Remit');
  });

  it('gives nothing for recorded transactions without a tag', () => {
    for (const [, dir, hash] of UNTAGGED) {
      const t = recordedTx(dir, hash);
      expect(typeof t.tx.Destination).toBe('string');
      expect(t.tx).not.toHaveProperty('DestinationTag');
      expect(parser.parse(t)).toBeUndefined();
    }
  });

  it('reads the tag whatever the type (synthetic: each source above with DestinationTag 7 added, and the recorded payment with TransactionType "FutureType")', () => {
    for (const [, dir, hash] of UNTAGGED) {
      const t = recordedTx(dir, hash);
      expect(parser.parse(edited(t, { DestinationTag: 7 }))).toEqual({
        destination: t.tx.Destination,
        destination_tag: 7,
      });
    }
    const payment = recordedTx(...PAYMENT);
    expect(parser.parse(edited(payment, { TransactionType: 'FutureType' }))).toEqual({
      destination: 'rUSyqwqFFYL6RJysH9o5RWNC4b8TiDJsQj',
      destination_tag: 19_593_017,
    });
  });

  it('reads the highest tag (synthetic: the recorded payment with DestinationTag 4294967295)', () => {
    expect(MAX_DESTINATION_TAG).toBe(4_294_967_295);
    const t = edited(recordedTx(...PAYMENT), { DestinationTag: 4_294_967_295 });
    expect(parser.parse(t)).toEqual({
      destination: 'rUSyqwqFFYL6RJysH9o5RWNC4b8TiDJsQj',
      destination_tag: 4_294_967_295,
    });
  });

  it('gives nothing, and does not throw, for a tag or a destination that is not one (synthetic: the recorded payment edited)', () => {
    const payment = recordedTx(...PAYMENT);
    const { Destination: _destination, ...withoutDestination } = payment.tx;
    const cases: ParserTx[] = [
      ...[4_294_967_296, -1, 1.5, '5', null, true, {}].map((tag) => edited(payment, { DestinationTag: tag })),
      deepFreeze({ ...payment, tx: withoutDestination }),
      edited(payment, { Destination: 5 }),
      edited(payment, { Destination: null }),
    ];
    for (const t of cases) {
      expect(() => parser.parse(t)).not.toThrow();
      expect(parser.parse(t)).toBeUndefined();
    }
  });
});
