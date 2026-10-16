/**
 * A scripted stand-in for the live node, for the `xrplStub` of `startHarness`: records every request the app sends and
 * answers with what the test says. The binary codec asks the node for `server_definitions` on its own account; that
 * request is answered with nothing (the codec then falls back to the bundled definitions) and left out of `requests()`,
 * so a test sees only the requests of the route it exercises.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type NodeRequest = { command: string } & Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type NodeHandler = (req: NodeRequest) => any;

export interface LiveNode {
  /** Pass as `xrplStub`. */
  stub: (req: NodeRequest) => Promise<unknown>;
  /** From now on answer with `handler`; forgets the requests seen so far. A thrown error is the node's error. */
  serve(handler: NodeHandler): void;
  /** The requests seen since the last `serve`, in order; only those of `command` when given. */
  requests(command?: string): NodeRequest[];
}

export function liveNode(): LiveNode {
  let handler: NodeHandler = (req) => {
    throw new Error(`The node was not scripted for ${req.command}`);
  };
  let seen: NodeRequest[] = [];
  return {
    stub: async (req) => {
      if (req.command === 'server_definitions') return undefined;
      // a copy: the app must not be able to change what the test later compares
      seen.push(structuredClone(req));
      return handler(req);
    },
    serve(next) {
      handler = next;
      seen = [];
    },
    requests: (command) => (command === undefined ? seen : seen.filter((r) => r.command === command)),
  };
}

/** A trust line as `account_lines` lists it. */
export function trustLine(currency: string, peer: string, balance: string): Record<string, unknown> {
  return {
    account: peer,
    balance,
    currency,
    limit: '1000000',
    limit_peer: '0',
    quality_in: 0,
    quality_out: 0,
  };
}

/** An offer as `account_offers` lists it. */
export function nodeOffer(o: {
  flags?: number;
  seq: number;
  quality: string;
  taker_gets: unknown;
  taker_pays: unknown;
}): Record<string, unknown> {
  return { ...o, flags: o.flags ?? 0 };
}

export interface Ledger {
  ledger_index: number;
  close_time: number;
}

/** The ledgers of the database as the tests need them: which one answers a date, and a stretch with none in it. */
export function ledgerClock(ledgers: Ledger[], minGap: number) {
  const i = ledgers.findIndex((l, n) => n + 1 < ledgers.length && ledgers[n + 1].close_time - l.close_time >= minGap);
  return {
    first: ledgers[0],
    last: ledgers[ledgers.length - 1],
    /** Two neighbouring ledgers at least `minGap` seconds apart: `from.close_time + 1` lies between them. */
    from: ledgers[i],
    to: ledgers[i + 1],
    /** The last ledger closed at or before the second: what a `date` resolves to. */
    atOrBefore: (seconds: number): Ledger => ledgers.filter((l) => l.close_time <= seconds).slice(-1)[0],
  };
}
