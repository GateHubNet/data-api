import { channelStatus, checkStatus, escrowStatus } from './object-status';

// F = 1000, C = 2000, E = 3000 (unix seconds)
describe('escrowStatus', () => {
  it('is pending up to finish_after, can_be_finished after it, and can_be_cancelled after cancel_after', () => {
    expect([999, 1000, 1001, 2000, 2001].map((t) => escrowStatus({ finishAfter: 1000, cancelAfter: 2000 }, t))).toEqual(
      ['pending', 'pending', 'can_be_finished', 'can_be_finished', 'can_be_cancelled'],
    );
  });

  it('can be finished from its creation without finish_after', () => {
    expect([escrowStatus({ cancelAfter: 2000 }, 1), escrowStatus({}, 1)]).toEqual([
      'can_be_finished',
      'can_be_finished',
    ]);
  });

  it('is what the deleting event says once it is deleted, whatever the time', () => {
    expect(['finish', 'cancel', 'removed'].map((e) => escrowStatus({ finishAfter: 1000, removedBy: e }, 1))).toEqual([
      'finished',
      'cancelled',
      'removed',
    ]);
    expect(escrowStatus({ finishAfter: 1000, cancelAfter: 2000, removedBy: 'finish' }, 5000)).toBe('finished');
  });
});

describe('checkStatus', () => {
  it('is open until its expiration and expired from it', () => {
    expect([2999, 3000].map((t) => checkStatus({ expiration: 3000 }, t))).toEqual(['open', 'expired']);
    expect(checkStatus({}, 9_999_999_999)).toBe('open');
  });

  it('is what the deleting event says once it is deleted, whatever the time', () => {
    expect(['cash', 'cancel', 'removed'].map((e) => checkStatus({ removedBy: e }, 1))).toEqual([
      'cashed',
      'cancelled',
      'removed',
    ]);
    expect(checkStatus({ expiration: 3000, removedBy: 'cash' }, 5000)).toBe('cashed');
  });
});

describe('channelStatus', () => {
  it('is closing once an expiration is set, or from cancel_after, else open', () => {
    expect([
      channelStatus({ expiration: 9_999_999 }, 1),
      channelStatus({ cancelAfter: 2000 }, 1999),
      channelStatus({ cancelAfter: 2000 }, 2000),
    ]).toEqual(['closing', 'open', 'closing']);
    expect(channelStatus({}, 1)).toBe('open');
  });

  it('is what the deleting event says once it is deleted, whatever the time', () => {
    expect(['close', 'removed'].map((e) => channelStatus({ removedBy: e }, 1))).toEqual(['closed', 'removed']);
    expect(channelStatus({ expiration: 3000, removedBy: 'close' }, 5000)).toBe('closed');
  });
});
