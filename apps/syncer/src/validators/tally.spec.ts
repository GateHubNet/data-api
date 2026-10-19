import {
  amendmentThreshold,
  quorumOf,
  RECORD_LIFETIME_SECONDS,
  RoundMembership,
  VoteRow,
} from '@gatehub/data-api-shared';
import { feesOfSetFee, missingRound, roundQuorum, TallyInput, tallyRound, voteAmendmentsOf } from './tally';

const A = 'A'.repeat(64);
const B = 'B'.repeat(64);
const C = 'C'.repeat(64);
const HOUR = 3600;
/** Round 1023 (a voting ledger: 256 * 4 - 1) and the time it closed. */
const ROUND = 1023;
const CLOSE = 1_760_000_000;
const VERSION = 1_760_000_100_000;
const FEES = { base_fee: '10', reserve_base: '1000000', reserve_inc: '200000' };

const names = (n: number): string[] => Array.from({ length: n }, (_, i) => `nHv${String(i).padStart(3, '0')}`);

/** A full validation of the round with no amendment votes, over `over`. */
function vote(key: string, over: Partial<VoteRow> = {}): VoteRow {
  return {
    ledger_index: ROUND,
    validation_public_key: key,
    close_time: CLOSE,
    full: 1,
    amendments: [],
    base_fee: null,
    reserve_base: null,
    reserve_inc: null,
    server_version: null,
    ...over,
  };
}

/** A vote of an earlier round `rounds` voting ledgers back, which closed `secondsAgo` before the round. */
const earlier = (key: string, rounds: number, secondsAgo: number, over: Partial<VoteRow> = {}): VoteRow =>
  vote(key, { ledger_index: ROUND - 256 * rounds, close_time: CLOSE - secondsAgo, ...over });

const members = (...unl: string[]): RoundMembership => ({ unl: new Set(unl), negativeUnl: new Set() });

function input(over: Partial<TallyInput> = {}): TallyInput {
  return {
    round: ROUND,
    closeTime: CLOSE,
    votes: [],
    history: [],
    membership: new Map(),
    unl: new Set(),
    negativeUnl: new Set(),
    majorities: [],
    fees: FEES,
    version: VERSION,
    ...over,
  };
}

/** The amendment rows without the sentinel, as `[id, yes]`. */
const yesOf = (tallies: { amendment_id: string; yes: number }[]) =>
  tallies.filter((row) => row.amendment_id !== '').map((row) => [row.amendment_id, row.yes]);

describe('tallyRound', () => {
  it('counts one record per UNL member, and the yes of each amendment over the records', () => {
    const unl = new Set(names(5));
    const [u0, u1, u2, u3] = names(5);
    const { tallies, observed, quorum } = tallyRound(
      input({
        unl,
        votes: [
          vote(u0, { amendments: [A] }),
          vote(u1, { amendments: [A] }),
          vote(u2, { amendments: [A] }),
          vote(u3, { amendments: [A, B] }),
        ],
      }),
    );
    expect(yesOf(tallies)).toEqual([
      [A, 4],
      [B, 1],
    ]);
    // 4 of 5 UNL members have a record; the threshold is that of 4 trusted
    for (const row of tallies) {
      expect(row).toMatchObject({ trusted: 4, threshold: 3, unl_size: 5, observed: 4, ledger_index: ROUND });
    }
    expect(observed).toBe(4);
    expect(quorum).toBe(4);
  });

  it('puts the sentinel last, with the UNL and the negative UNL sorted and the fees in force', () => {
    const [u0, u1, u2] = names(3);
    const { tallies } = tallyRound(
      input({
        unl: new Set([u2, u0, u1]),
        negativeUnl: new Set([u2, 'nHoutside']),
        votes: [vote(u0, { amendments: [A] }), vote(u1, { amendments: [A] })],
      }),
    );
    expect(tallies.map((row) => row.amendment_id)).toEqual([A, '']);
    expect(tallies[tallies.length - 1]).toEqual({
      ledger_index: ROUND,
      amendment_id: '',
      close_time: CLOSE,
      yes: 0,
      trusted: 2,
      threshold: 1,
      unl_size: 3,
      observed: 2,
      unl: [u0, u1, u2],
      negative_unl: ['nHoutside', u2],
      base_fee: '10',
      reserve_base: '1000000',
      reserve_inc: '200000',
      version: VERSION,
    });
  });

  it('leaves the sentinel-only columns empty on the rows of the amendments', () => {
    const [u0] = names(1);
    const { tallies } = tallyRound(
      input({ unl: new Set([u0]), negativeUnl: new Set(['x']), votes: [vote(u0, { amendments: [A] })] }),
    );
    expect(tallies[0]).toEqual({
      ledger_index: ROUND,
      amendment_id: A,
      close_time: CLOSE,
      yes: 1,
      trusted: 1,
      threshold: 1,
      unl_size: 1,
      observed: 1,
      unl: [],
      negative_unl: [],
      base_fee: '0',
      reserve_base: '0',
      reserve_inc: '0',
      version: VERSION,
    });
  });

  it('writes one version on every row', () => {
    const [u0, u1] = names(2);
    const { tallies } = tallyRound(
      input({
        unl: new Set([u0, u1]),
        votes: [vote(u0, { amendments: [A, B] }), vote(u1, { amendments: [C] })],
        version: 42,
      }),
    );
    expect(tallies).toHaveLength(4);
    expect(new Set(tallies.map((row) => row.version))).toEqual(new Set([42]));
  });

  it('orders the rows of the amendments by ID', () => {
    const [u0] = names(1);
    const { tallies } = tallyRound(
      input({ unl: new Set([u0]), votes: [vote(u0, { amendments: [C, A, B] })], majorities: ['D'.repeat(64)] }),
    );
    expect(tallies.map((row) => row.amendment_id)).toEqual([A, B, C, 'D'.repeat(64), '']);
  });

  it('has the threshold of 28 for 35 trusted validators', () => {
    const unl = new Set(names(35));
    const { tallies } = tallyRound(input({ unl, votes: names(35).map((key) => vote(key, { amendments: [A] })) }));
    expect(tallies[0]).toMatchObject({ amendment_id: A, yes: 35, trusted: 35, threshold: 28, unl_size: 35 });
    expect(amendmentThreshold(35)).toBe(28);
  });

  it('counts a record in the trusted figure whether or not it votes for an amendment', () => {
    const [u0, u1] = names(2);
    const { tallies } = tallyRound(
      input({ unl: new Set([u0, u1]), votes: [vote(u0, { amendments: [] }), vote(u1, { amendments: [A] })] }),
    );
    expect(tallies[0]).toMatchObject({ amendment_id: A, yes: 1, trusted: 2, threshold: 1 });
  });

  it('counts an amendment once per record, however often the record names it', () => {
    const [u0] = names(1);
    const { tallies } = tallyRound(input({ unl: new Set([u0]), votes: [vote(u0, { amendments: [A, A, A] })] }));
    expect(yesOf(tallies)).toEqual([[A, 1]]);
  });

  it('ignores the votes of validators that are not on the UNL', () => {
    const [u0] = names(1);
    const { tallies, observed } = tallyRound(
      input({
        unl: new Set([u0]),
        votes: [vote(u0, { amendments: [A] }), vote('nHstranger', { amendments: [A, B] })],
      }),
    );
    expect(yesOf(tallies)).toEqual([[A, 1]]);
    expect(tallies[0].trusted).toBe(1);
    expect(observed).toBe(1);
  });

  describe('the 24 h carry (F7)', () => {
    const [u0, u1] = names(2);

    /** u1 has a vote for A that closed `secondsAgo` before the round, in a round it was on the UNL of. */
    function withEarlierVote(secondsAgo: number) {
      const old = earlier(u1, 1, secondsAgo, { amendments: [A] });
      return tallyRound(
        input({
          unl: new Set([u0, u1]),
          votes: [vote(u0, { amendments: [A] })],
          history: [old],
          membership: new Map([[old.ledger_index, members(u0, u1)]]),
        }),
      ).tallies[0];
    }

    it('counts a record from 23 hours ago', () => {
      expect(withEarlierVote(23 * HOUR)).toMatchObject({ amendment_id: A, yes: 2, trusted: 2 });
    });

    it('counts a record from exactly 24 hours ago', () => {
      expect(RECORD_LIFETIME_SECONDS).toBe(24 * HOUR);
      expect(withEarlierVote(24 * HOUR)).toMatchObject({ amendment_id: A, yes: 2, trusted: 2 });
    });

    it('does not count a record from a second more than 24 hours ago', () => {
      expect(withEarlierVote(24 * HOUR + 1)).toMatchObject({ amendment_id: A, yes: 1, trusted: 1 });
    });

    it('does not count a record from 25 hours ago', () => {
      expect(withEarlierVote(25 * HOUR)).toMatchObject({ amendment_id: A, yes: 1, trusted: 1 });
    });

    it('takes the newest full record of a validator, not the oldest', () => {
      const old = earlier(u1, 3, 3 * HOUR, { amendments: [A] });
      const newer = earlier(u1, 1, HOUR, { amendments: [B] });
      const { tallies } = tallyRound(
        input({
          unl: new Set([u0, u1]),
          votes: [vote(u0)],
          history: [old, newer],
          membership: new Map([
            [old.ledger_index, members(u0, u1)],
            [newer.ledger_index, members(u0, u1)],
          ]),
        }),
      );
      expect(yesOf(tallies)).toEqual([[B, 1]]);
    });

    it('prefers the vote of the round to an earlier one', () => {
      const old = earlier(u1, 1, HOUR, { amendments: [A] });
      const { tallies } = tallyRound(
        input({
          unl: new Set([u1]),
          votes: [vote(u1, { amendments: [B] })],
          history: [old],
          membership: new Map([[old.ledger_index, members(u1)]]),
        }),
      );
      expect(yesOf(tallies)).toEqual([[B, 1]]);
    });

    it('does not take a partial validation for a record, in this round or an earlier one', () => {
      const old = earlier(u1, 2, 2 * HOUR, { amendments: [A] });
      const partial = earlier(u1, 1, HOUR, { amendments: [B], full: 0 });
      const { tallies } = tallyRound(
        input({
          unl: new Set([u0, u1]),
          votes: [vote(u0), vote(u1, { amendments: [C], full: 0 })],
          history: [old, partial],
          membership: new Map([
            [old.ledger_index, members(u0, u1)],
            [partial.ledger_index, members(u0, u1)],
          ]),
        }),
      );
      expect(yesOf(tallies)).toEqual([[A, 1]]);
    });

    it('does not count a vote of a round after this one', () => {
      const later = vote(u1, { ledger_index: ROUND + 256, close_time: CLOSE + 1000, amendments: [A] });
      const { tallies } = tallyRound(
        input({
          unl: new Set([u1]),
          history: [later],
          membership: new Map([[later.ledger_index, members(u1)]]),
        }),
      );
      expect(tallies).toHaveLength(1); // the sentinel
      expect(tallies[0].trusted).toBe(0);
    });
  });

  describe('who counts', () => {
    const [u0, u1, u2] = names(3);

    it('does not let a round on which the validator was on the negative UNL refresh its record', () => {
      const old = earlier(u1, 2, 2 * HOUR, { amendments: [A] });
      const flagged = earlier(u1, 1, HOUR, { amendments: [B] });
      const { tallies } = tallyRound(
        input({
          unl: new Set([u0, u1]),
          negativeUnl: new Set([u1]),
          // u1 votes C in this round too, but it is on the negative UNL of this round
          votes: [vote(u0, { amendments: [A] }), vote(u1, { amendments: [C] })],
          history: [old, flagged],
          membership: new Map<number, RoundMembership>([
            [old.ledger_index, members(u0, u1)],
            [flagged.ledger_index, { unl: new Set([u0, u1]), negativeUnl: new Set([u1]) }],
          ]),
        }),
      );
      // the record of u1 is still the one of the round before the negative UNL
      expect(yesOf(tallies)).toEqual([[A, 2]]);
      expect(tallies[0].trusted).toBe(2);
    });

    it('has no record for a validator on the negative UNL that has never had one off it', () => {
      const { tallies, observed } = tallyRound(
        input({
          unl: new Set([u0, u1]),
          negativeUnl: new Set([u1]),
          votes: [vote(u0, { amendments: [A] }), vote(u1, { amendments: [A] })],
        }),
      );
      expect(yesOf(tallies)).toEqual([[A, 1]]);
      expect(tallies[0].trusted).toBe(1);
      // its validation was seen all the same
      expect(observed).toBe(2);
    });

    it('counts a validator that joined the UNL only by the records of the rounds it was on the UNL of', () => {
      const beforeJoining = earlier(u2, 2, 2 * HOUR, { amendments: [B] });
      const afterJoining = earlier(u2, 1, HOUR, { amendments: [A] });
      const base = {
        unl: new Set([u0, u2]),
        votes: [vote(u0)],
        membership: new Map<number, RoundMembership>([
          [beforeJoining.ledger_index, members(u0)],
          [afterJoining.ledger_index, members(u0, u2)],
        ]),
      };
      // only the vote from before it joined: no record
      const without = tallyRound(input({ ...base, history: [beforeJoining] }));
      expect(without.tallies).toHaveLength(1);
      expect(without.tallies[0].trusted).toBe(1);
      // a vote from a round it was on the UNL of counts, and is the newest
      const withIt = tallyRound(input({ ...base, history: [beforeJoining, afterJoining] }));
      expect(yesOf(withIt.tallies)).toEqual([[A, 1]]);
      expect(withIt.tallies[0].trusted).toBe(2);
    });

    it('has no record for a vote of a round that has no entry among the memberships', () => {
      const orphan = earlier(u1, 1, HOUR, { amendments: [A] });
      const { tallies } = tallyRound(input({ unl: new Set([u1]), history: [orphan] }));
      expect(tallies).toHaveLength(1);
      expect(tallies[0].trusted).toBe(0);
    });

    it('takes the membership of the round from its own UNL and negative UNL', () => {
      // the memberships given have an entry for the round that says otherwise: the round is what it is told to be
      const { tallies } = tallyRound(
        input({
          unl: new Set([u0]),
          votes: [vote(u0, { amendments: [A] })],
          membership: new Map([[ROUND, { unl: new Set<string>(), negativeUnl: new Set([u0]) }]]),
        }),
      );
      expect(yesOf(tallies)).toEqual([[A, 1]]);
    });
  });

  describe('observed and quorum', () => {
    it('counts the UNL members that have a full validation in this round, and no one else', () => {
      const unl = new Set(names(6));
      const [u0, u1, u2, u3] = names(6);
      const old = earlier(u3, 1, HOUR);
      const { tallies, observed } = tallyRound(
        input({
          unl,
          votes: [vote(u0), vote(u1), vote(u2, { full: 0 }), vote('nHstranger')],
          history: [old],
          membership: new Map([[old.ledger_index, members(...unl)]]),
        }),
      );
      expect(observed).toBe(2);
      expect(tallies[tallies.length - 1]).toMatchObject({ observed: 2, unl_size: 6, trusted: 3 });
    });

    it('gives the quorum of the UNL and of the members of the negative UNL that are on it', () => {
      const unl = new Set(names(10));
      const [, , , , , , , , u8, u9] = names(10);
      const { quorum } = tallyRound(input({ unl, negativeUnl: new Set([u8, u9, 'nHnot-on-the-unl']) }));
      expect(quorum).toBe(quorumOf(10, 2));
      expect(quorum).toBe(7);
      expect(tallyRound(input({ unl })).quorum).toBe(quorumOf(10, 0));
      expect(tallyRound(input({ unl })).quorum).toBe(8);
    });
  });

  describe('the amendments in a majority', () => {
    it('gets a row with no yes when no record votes for it', () => {
      const [u0] = names(1);
      const { tallies } = tallyRound(
        input({ unl: new Set([u0]), votes: [vote(u0, { amendments: [A] })], majorities: [B] }),
      );
      expect(yesOf(tallies)).toEqual([
        [A, 1],
        [B, 0],
      ]);
      expect(tallies.find((row) => row.amendment_id === B)).toMatchObject({ trusted: 1, threshold: 1 });
    });

    it('has one row when the amendment is in a majority and has votes, or is listed twice', () => {
      const [u0] = names(1);
      const { tallies } = tallyRound(
        input({ unl: new Set([u0]), votes: [vote(u0, { amendments: [A] })], majorities: [A, B, B] }),
      );
      expect(yesOf(tallies)).toEqual([
        [A, 1],
        [B, 0],
      ]);
    });

    it('is the only thing that gives a row to an amendment nobody votes for', () => {
      const [u0] = names(1);
      expect(tallyRound(input({ unl: new Set([u0]), votes: [vote(u0)] })).tallies).toHaveLength(1);
    });
  });

  it('gives only the sentinel, a threshold of 1 and a quorum of 0 for an empty UNL', () => {
    const { tallies, observed, quorum } = tallyRound(input({ votes: [vote('nHstranger', { amendments: [A] })] }));
    expect(tallies).toEqual([
      {
        ledger_index: ROUND,
        amendment_id: '',
        close_time: CLOSE,
        yes: 0,
        trusted: 0,
        threshold: 1,
        unl_size: 0,
        observed: 0,
        unl: [],
        negative_unl: [],
        base_fee: '10',
        reserve_base: '1000000',
        reserve_inc: '200000',
        version: VERSION,
      },
    ]);
    expect(observed).toBe(0);
    expect(quorum).toBe(0);
  });

  it('does not change its input', () => {
    const [u0, u1] = names(2);
    const old = earlier(u1, 1, HOUR, { amendments: [A] });
    const given = input({
      unl: new Set([u1, u0]),
      negativeUnl: new Set(['nHx']),
      votes: [vote(u0, { amendments: [B, A] })],
      history: [old],
      membership: new Map([[old.ledger_index, members(u0, u1)]]),
      majorities: [C],
    });
    const frozen = JSON.stringify(input2json(given));
    tallyRound(given);
    expect(JSON.stringify(input2json(given))).toBe(frozen);
  });
});

/** The input as JSON (sets and maps as arrays), to compare before and after. */
function input2json(i: TallyInput) {
  return {
    ...i,
    unl: [...i.unl],
    negativeUnl: [...i.negativeUnl],
    membership: [...i.membership].map(([ledger, m]) => [ledger, [...m.unl], [...m.negativeUnl]]),
  };
}

describe('roundQuorum', () => {
  it('is the quorum of the UNL less the members of the negative UNL that are on it', () => {
    const unl = new Set(names(10));
    const [u0, u1] = names(10);
    expect(roundQuorum(unl, new Set())).toBe(quorumOf(10, 0));
    expect(roundQuorum(unl, new Set([u0, u1, 'nHoutside']))).toBe(quorumOf(10, 2));
    expect(roundQuorum(new Set(), new Set(['nHoutside']))).toBe(0);
  });
});

describe('missingRound', () => {
  it('is the sentinel of a round with no ledger: observed 0, trusted 0, threshold 1, the size of the UNL', () => {
    const row = missingRound({
      round: ROUND,
      closeTime: CLOSE + 12,
      unl: new Set(['nHb', 'nHa', 'nHc']),
      negativeUnl: new Set(['nHc']),
      fees: FEES,
      version: VERSION,
    });
    expect(row).toEqual({
      ledger_index: ROUND,
      amendment_id: '',
      close_time: CLOSE + 12,
      yes: 0,
      trusted: 0,
      threshold: 1,
      unl_size: 3,
      observed: 0,
      unl: ['nHa', 'nHb', 'nHc'],
      negative_unl: ['nHc'],
      base_fee: '10',
      reserve_base: '1000000',
      reserve_inc: '200000',
      version: VERSION,
    });
  });
});

describe('voteAmendmentsOf', () => {
  it('is empty for the empty text and for an empty list', () => {
    expect(voteAmendmentsOf('')).toEqual([]);
    expect(voteAmendmentsOf('[]')).toEqual([]);
    expect(voteAmendmentsOf(null)).toEqual([]);
    expect(voteAmendmentsOf(undefined)).toEqual([]);
  });

  it('reads the JSON list of IDs, in upper case and once each', () => {
    expect(voteAmendmentsOf(JSON.stringify([A, B.toLowerCase(), A]))).toEqual([A, B]);
  });

  it('keeps nothing that is not an amendment ID, and nothing of text that is not a list', () => {
    expect(voteAmendmentsOf(JSON.stringify([A, 'not-an-id', 7, null, 'AB']))).toEqual([A]);
    expect(voteAmendmentsOf('not json')).toEqual([]);
    expect(voteAmendmentsOf('{"a":1}')).toEqual([]);
    expect(voteAmendmentsOf('"text"')).toEqual([]);
  });
});

describe('feesOfSetFee', () => {
  it('reads the drops fields of a SetFee after the XRPFees amendment', () => {
    const tx = {
      TransactionType: 'SetFee',
      BaseFeeDrops: '10',
      ReserveBaseDrops: '1000000',
      ReserveIncrementDrops: '200000',
    };
    expect(feesOfSetFee(JSON.stringify(tx))).toEqual(FEES);
  });

  it('reads the legacy fields: BaseFee in hex, the reserves as numbers or text', () => {
    const tx = {
      TransactionType: 'SetFee',
      BaseFee: '000000000000000A',
      ReferenceFeeUnits: 10,
      ReserveBase: 10_000_000,
      ReserveIncrement: '2000000',
    };
    expect(feesOfSetFee(JSON.stringify(tx))).toEqual({
      base_fee: '10',
      reserve_base: '10000000',
      reserve_inc: '2000000',
    });
  });

  it('reads a field from its drops form when it has both, and field by field', () => {
    const tx = { BaseFeeDrops: '12', BaseFee: '000000000000000A', ReserveBase: 5, ReserveIncrementDrops: '7' };
    expect(feesOfSetFee(JSON.stringify(tx))).toEqual({ base_fee: '12', reserve_base: '5', reserve_inc: '7' });
  });

  it('keeps an amount above 2^53 exact', () => {
    const tx = {
      BaseFeeDrops: '18446744073709551615',
      ReserveBaseDrops: '9007199254740993',
      ReserveIncrementDrops: '0',
    };
    expect(feesOfSetFee(JSON.stringify(tx))).toEqual({
      base_fee: '18446744073709551615',
      reserve_base: '9007199254740993',
      reserve_inc: '0',
    });
  });

  it('is undefined when a fee is missing or is not an amount, or the text is not a transaction', () => {
    const ok = { BaseFeeDrops: '10', ReserveBaseDrops: '1', ReserveIncrementDrops: '2' };
    expect(feesOfSetFee(JSON.stringify({ ...ok, ReserveIncrementDrops: undefined }))).toBeUndefined();
    expect(feesOfSetFee(JSON.stringify({ ...ok, BaseFeeDrops: '-1' }))).toBeUndefined();
    expect(feesOfSetFee(JSON.stringify({ ...ok, BaseFeeDrops: '1.5' }))).toBeUndefined();
    expect(feesOfSetFee(JSON.stringify({ ...ok, BaseFeeDrops: '18446744073709551616' }))).toBeUndefined();
    expect(feesOfSetFee(JSON.stringify({ ...ok, ReserveBaseDrops: null }))).toBeUndefined();
    expect(feesOfSetFee(JSON.stringify({ BaseFee: 'xyz', ReserveBase: 1, ReserveIncrement: 2 }))).toBeUndefined();
    expect(feesOfSetFee('not json')).toBeUndefined();
    expect(feesOfSetFee('[]')).toBeUndefined();
    expect(feesOfSetFee('7')).toBeUndefined();
    expect(feesOfSetFee('{}')).toBeUndefined();
  });
});
