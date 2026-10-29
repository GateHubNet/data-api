import { PATH_METADATA } from '@nestjs/common/constants';
import { classicAddressToXAddress, encodeAccountID } from 'ripple-address-codec';
import { RippleHttpError } from '../common/errors';
import { RippleErrorFilter } from '../common/ripple-error.filter';
import { AccountNamesController, MAX_ADDRESSES, parseAddresses } from './account-names.controller';
import type { AccountNameData, DisplayNamesService } from './display-names.service';

const TREASURY = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const PAYROLL = 'rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn';
const HARBOR = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';

/** The `n`-th valid classic address of a series (the AccountID is the number). */
const address = (n: number): string => {
  const id = Buffer.alloc(20);
  id.writeUInt32BE(n, 16);
  return encodeAccountID(id);
};

/** The message of the 400 `parseAddresses` throws for `query`, or `'ok'` when it parses. */
function verdict(query: Record<string, unknown>): string {
  try {
    parseAddresses(query);
    return 'ok';
  } catch (err) {
    expect(err).toBeInstanceOf(RippleHttpError);
    expect((err as RippleHttpError).getStatus()).toBe(400);
    return ((err as RippleHttpError).getResponse() as { message: string }).message;
  }
}

describe('parseAddresses', () => {
  it('is capped at 100', () => {
    expect(MAX_ADDRESSES).toBe(100);
  });

  it('gives the addresses in the order asked, a repeated one at each place', () => {
    expect(parseAddresses({ addresses: `${TREASURY},${PAYROLL},${TREASURY}` })).toEqual([TREASURY, PAYROLL, TREASURY]);
    expect(parseAddresses({ addresses: HARBOR })).toEqual([HARBOR]);
  });

  it('accepts 100 addresses, a repeated address counting towards the 100', () => {
    const hundred = Array.from({ length: 100 }, (_, i) => address(i + 1));
    expect(parseAddresses({ addresses: hundred.join(',') })).toEqual(hundred);
    expect(parseAddresses({ addresses: Array(100).fill(TREASURY).join(',') })).toHaveLength(100);
  });

  it('answers 400 addresses is required for a missing or empty parameter', () => {
    expect(verdict({})).toBe('addresses is required');
    expect(verdict({ addresses: '' })).toBe('addresses is required');
    expect(verdict({ addresses: undefined })).toBe('addresses is required');
    expect(verdict({ addresses: { nested: TREASURY } })).toBe('addresses is required');
    expect(verdict({ other: TREASURY })).toBe('addresses is required');
  });

  it('answers 400 too many addresses - at most 100 for 101 addresses, before it checks any of them', () => {
    const valid = Array.from({ length: 101 }, (_, i) => address(i + 1));
    expect(verdict({ addresses: valid.join(',') })).toBe('too many addresses - at most 100');
    // none of them is an address, and there are 101: the count comes first
    expect(verdict({ addresses: Array(101).fill('x').join(',') })).toBe('too many addresses - at most 100');
    expect(verdict({ addresses: ','.repeat(100) })).toBe('too many addresses - at most 100');
    // and 100 commas make 101 empty elements, but 99 make 100: those are the invalid ones
    expect(verdict({ addresses: ','.repeat(99) })).toBe('invalid ripple address');
  });

  it('answers 400 invalid ripple address for an empty element, an X-address, a bad checksum or anything else', () => {
    const xAddress = classicAddressToXAddress(TREASURY, false, false);
    expect(xAddress).toMatch(/^X/);
    const badChecksum = `${TREASURY.slice(0, -1)}${TREASURY.endsWith('h') ? 'g' : 'h'}`;
    const cases = [
      `${TREASURY},,${PAYROLL}`,
      `${TREASURY},`,
      `,${TREASURY}`,
      ',',
      xAddress,
      `${TREASURY},${xAddress}`,
      badChecksum,
      TREASURY.toLowerCase(),
      'not-an-address',
      '5',
    ];
    for (const addresses of cases)
      expect([addresses, verdict({ addresses })]).toEqual([addresses, 'invalid ripple address']);
  });

  it('does not trim: a space makes the address invalid', () => {
    expect(verdict({ addresses: `${TREASURY}, ${PAYROLL}` })).toBe('invalid ripple address');
    expect(verdict({ addresses: ` ${TREASURY}` })).toBe('invalid ripple address');
    expect(verdict({ addresses: `${TREASURY} ` })).toBe('invalid ripple address');
  });

  it('reads the first of a repeated parameter or of an array (addresses[]=)', () => {
    expect(parseAddresses({ addresses: [`${TREASURY},${PAYROLL}`, HARBOR] })).toEqual([TREASURY, PAYROLL]);
    expect(parseAddresses({ addresses: [HARBOR] })).toEqual([HARBOR]);
    expect(verdict({ addresses: [''] })).toBe('addresses is required');
    expect(verdict({ addresses: ['', TREASURY] })).toBe('addresses is required');
    expect(verdict({ addresses: ['nope', TREASURY] })).toBe('invalid ripple address');
  });

  it('checks the cases in the order missing, too many, invalid', () => {
    const tooManyAndInvalid = `${Array.from({ length: 100 }, (_, i) => address(i + 1)).join(',')},nope`;
    expect(verdict({ addresses: tooManyAndInvalid })).toBe('too many addresses - at most 100');
    expect(verdict({ addresses: `${TREASURY},nope` })).toBe('invalid ripple address');
    expect(verdict({ addresses: '' })).toBe('addresses is required');
  });
});

describe('AccountNamesController', () => {
  const DATA: AccountNameData[] = [
    { address: TREASURY, display_name: { text: 'Northpeak Treasury', kind: 'verified' }, domain: 'northpeak.example' },
    { address: PAYROLL },
    { address: TREASURY, display_name: { text: 'Northpeak Treasury', kind: 'verified' }, domain: 'northpeak.example' },
  ];

  function setup(of: jest.Mock = jest.fn(async () => DATA)) {
    return { controller: new AccountNamesController({ of } as unknown as DisplayNamesService), of };
  }

  it('is GET /v2/account_names, with the failure message of the route', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AccountNamesController)).toBe('v2/account_names');
    expect(Reflect.getMetadata('__exceptionFilters__', AccountNamesController)).toEqual([RippleErrorFilter]);
    const handler = AccountNamesController.prototype.list;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('/');
    expect(Reflect.getMetadata('ripple:failure-message', handler)).toBe('unable to retrieve account names');
  });

  it('answers success, the count and one entry per address asked, in the order asked', async () => {
    const { controller, of } = setup();

    const body = await controller.list({ addresses: `${TREASURY},${PAYROLL},${TREASURY}` });

    expect(of).toHaveBeenCalledTimes(1);
    expect(of).toHaveBeenCalledWith([TREASURY, PAYROLL, TREASURY]);
    expect(Object.keys(body)).toEqual(['result', 'count', 'account_names']);
    expect(body).toEqual({
      result: 'success',
      count: 3,
      account_names: [
        {
          address: TREASURY,
          display_name: { text: 'Northpeak Treasury', kind: 'verified' },
          domain: 'northpeak.example',
        },
        { address: PAYROLL },
        {
          address: TREASURY,
          display_name: { text: 'Northpeak Treasury', kind: 'verified' },
          domain: 'northpeak.example',
        },
      ],
    });
  });

  it('reads nothing when the query is wrong: the 400 is thrown before the names are asked', async () => {
    const { controller, of } = setup();

    await expect(controller.list({})).rejects.toMatchObject({ response: { message: 'addresses is required' } });
    await expect(controller.list({ addresses: 'nope' })).rejects.toMatchObject({
      response: { message: 'invalid ripple address' },
    });
    expect(of).not.toHaveBeenCalled();
  });

  it('lets the failure of the read through, for the route to answer 500 unable to retrieve account names', async () => {
    const failure = new Error('Code: 60. DB::Exception: Table account_domains does not exist');
    const { controller } = setup(jest.fn().mockRejectedValue(failure));

    await expect(controller.list({ addresses: TREASURY })).rejects.toBe(failure);
  });
});
