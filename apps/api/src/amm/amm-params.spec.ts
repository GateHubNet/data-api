import { eventParam, typeParam } from './amm-params';

const message = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (err) {
    return (err as { getStatus(): number; response: unknown }).getStatus() === 400
      ? (err as { response: { message: string } }).response.message
      : 'not a 400';
  }
  return 'no error';
};

describe('eventParam', () => {
  it('is each event the parser writes, and nothing for a missing or empty one', () => {
    for (const event of ['create', 'deposit', 'withdraw', 'clawback', 'delete']) {
      expect(eventParam({ event })).toBe(event);
    }
    expect(eventParam({})).toBeUndefined();
    expect(eventParam({ event: '' })).toBeUndefined();
    expect(eventParam({ event: ['withdraw', 'deposit'] })).toBe('withdraw');
  });

  it('answers 400 invalid event for anything else, also another case or spelling', () => {
    for (const event of ['DEPOSIT', 'Deposit', ' deposit', 'deposit ', 'swap', 'vote', 'bid', '0', 'all']) {
      expect([event, message(() => eventParam({ event }))]).toEqual([event, 'invalid event']);
    }
  });
});

describe('typeParam', () => {
  it('is vote or bid, and nothing for a missing or empty one', () => {
    expect(typeParam({ type: 'vote' })).toBe('vote');
    expect(typeParam({ type: 'bid' })).toBe('bid');
    expect(typeParam({})).toBeUndefined();
    expect(typeParam({ type: '' })).toBeUndefined();
  });

  it('answers 400 invalid type for anything else', () => {
    for (const type of ['Vote', 'BID', 'votes', 'kind', 'deposit', '0']) {
      expect([type, message(() => typeParam({ type }))]).toEqual([type, 'invalid type']);
    }
  });
});
