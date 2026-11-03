import { RippleHttpError } from '../common/errors';
import { objectIdParam } from './object-params';

describe('objectIdParam', () => {
  const ID = 'B95064B1A92F02EE009E6BDFB369CF476FB925BB8615456970E38774034A5D30';

  it('is 64 hex digits in either case, answered in upper case', () => {
    expect(objectIdParam(ID, 'invalid escrow id')).toBe(ID);
    expect(objectIdParam(ID.toLowerCase(), 'invalid escrow id')).toBe(ID);
    expect(objectIdParam(`${ID.slice(0, 32)}${ID.slice(32).toLowerCase()}`, 'invalid escrow id')).toBe(ID);
  });

  it.each(['', 'XYZ', ID.slice(1), `${ID}0`, `${'G'.repeat(64)}`, ` ${ID}`, `${ID}\n`, `0x${ID.slice(2)}`])(
    'is a 400 with the message of the route for %j',
    (raw) => {
      const thrown = (() => {
        try {
          objectIdParam(raw, 'invalid check id');
        } catch (err) {
          return err;
        }
        return undefined;
      })();
      expect(thrown).toBeInstanceOf(RippleHttpError);
      expect((thrown as RippleHttpError).getStatus()).toBe(400);
      expect((thrown as RippleHttpError).getResponse()).toEqual({ result: 'error', message: 'invalid check id' });
    },
  );
});
