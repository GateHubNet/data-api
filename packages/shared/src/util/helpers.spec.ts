import { allSettledOrThrow } from './helpers';

describe('allSettledOrThrow', () => {
  it('resolves once every promise has resolved', async () => {
    await expect(allSettledOrThrow([Promise.resolve(1), Promise.resolve(2)])).resolves.toBeUndefined();
  });

  it('resolves for an empty list', async () => {
    await expect(allSettledOrThrow([])).resolves.toBeUndefined();
  });

  it('waits for the slow promises before rejecting with the first failure, so nothing is left in flight', async () => {
    let slowDone = false;
    const slow = new Promise<void>((resolve) =>
      setTimeout(() => {
        slowDone = true;
        resolve();
      }, 30),
    );
    const early = new Error('early');
    const late = new Error('late');
    const lateFailure = new Promise<never>((_, reject) => setTimeout(() => reject(late), 10));

    await expect(allSettledOrThrow([slow, Promise.reject(early), lateFailure])).rejects.toBe(early);
    expect(slowDone).toBe(true);
  });
});
