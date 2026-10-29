import { createHash } from 'crypto';
import { decodeAccountID } from 'ripple-address-codec';
import { ObjectNet, objectLedgers } from '../test-utils/object-cases';
import { ESCROW_SPACE, escrowId, ledgerObjectSpace } from './keylets';

const OWNER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';

/** The EscrowCreate transactions of the recorded ledgers that succeeded, with the escrow node the metadata created. */
function recordedEscrows(net: ObjectNet): { hash: string; owner: string; sequence: number; created: string }[] {
  const found: { hash: string; owner: string; sequence: number; created: string }[] = [];
  for (const ledger of objectLedgers(net)) {
    for (const { hash, tx, meta } of ledger.transactions) {
      if (tx.TransactionType !== 'EscrowCreate' || meta.TransactionResult !== 'tesSUCCESS') continue;
      const nodes = (meta.AffectedNodes as Record<string, any>[]).map((n) => n.CreatedNode);
      const node = nodes.find((n) => n?.LedgerEntryType === 'Escrow');
      found.push({
        hash,
        owner: tx.Account as string,
        sequence: (tx.Sequence as number) || (tx.TicketSequence as number),
        created: node.LedgerIndex as string,
      });
    }
  }
  return found;
}

describe('escrowId', () => {
  it.each(['xrpl', 'xahau'] as const)('%s: every recorded EscrowCreate created the node escrowId names', (net) => {
    const escrows = recordedEscrows(net);
    expect(escrows.length).toBeGreaterThan(0);
    for (const e of escrows) {
      expect({ hash: e.hash, id: escrowId(e.owner, e.sequence) }).toEqual({ hash: e.hash, id: e.created });
    }
  });

  it('is the SHA-512Half of the space key, the AccountID and the sequence', () => {
    const body = Buffer.concat([Buffer.from(decodeAccountID(OWNER)), Buffer.from([0, 0, 0x30, 0x39])]);
    const space = Buffer.from([0x00, 0x75]);
    const expected = createHash('sha512').update(space).update(body).digest().subarray(0, 32).toString('hex');
    expect(ESCROW_SPACE).toBe(0x0075);
    expect(escrowId(OWNER, 12345)).toBe(expected.toUpperCase());
    expect(ledgerObjectSpace(ESCROW_SPACE, body)).toBe(expected.toUpperCase());
  });

  it('answers 64 upper-case hex digits, and takes a sequence from 0 to 2^32 - 1', () => {
    for (const sequence of [0, 1, 2 ** 32 - 1]) expect(escrowId(OWNER, sequence)).toMatch(/^[0-9A-F]{64}$/);
    expect(escrowId(OWNER, 0)).not.toBe(escrowId(OWNER, 1));
    expect(escrowId(OWNER, 2 ** 32 - 1)).not.toBe(escrowId(OWNER, 0));
  });

  it('refuses an X-address, a bad address and a sequence of 2^32', () => {
    expect(() => escrowId('XVPcpSm47b1CZkf5AkKM9a84dQHe3m4sBhsrA4XtnBECTAc', 1)).toThrow();
    expect(() => escrowId(OWNER.slice(0, -1), 1)).toThrow();
    expect(() => escrowId('', 1)).toThrow();
    expect(() => escrowId(OWNER, 2 ** 32)).toThrow(RangeError);
    expect(() => escrowId(OWNER, -1)).toThrow(RangeError);
    expect(() => escrowId(OWNER, 1.5)).toThrow(RangeError);
    expect(() => escrowId(OWNER, NaN)).toThrow(RangeError);
  });
});
