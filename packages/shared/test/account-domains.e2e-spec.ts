import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { Table } from '../src/clickhouse/tables';
import { FixtureLedgerSource } from '../src/ingest/fixture-ledger-source';
import { deleteLedgerRange } from '../src/ingest/ingest-state';
import { LedgerWriter } from '../src/ingest/ledger-writer';
import { RawLedger, RawTransaction } from '../src/ingest/raw-ledger';
import { getNetworkProfile } from '../src/network';
import { accountDomainVersion } from '../src/parsers/account-domains.parser';
import { parseContextFor } from '../src/parsers/parser.interface';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';

const FIXTURES = join(__dirname, 'fixtures');

/** Reads give back what was written when UInt64 is quoted (exact). */
const READ_SETTINGS = { output_format_json_quote_64bit_integers: 1 } as const;

type Json = Readonly<Record<string, any>>;

/** A recorded transaction: where it is, and what it is. The `cases` of a fixture manifest hold these, with a note. */
interface CaseRef {
  ledger: number;
  hash: string;
  type: string;
}

/**
 * What the newest `account_domains` row of an account must say after the ledgers are written, and the recorded
 * transaction it comes from. The values are read off the ledger's metadata, not off the parser: `account` is the root
 * the transaction left (`FinalFields.Account`), `domain_hex` its `Domain` after the transaction (as the node served it).
 */
interface DomainCase {
  /** The key in the `cases` of the manifest of `dir`; for a ledger read in place, the case it stands for. */
  name: string;
  /** The fixture directory that holds the ledger. */
  dir: string;
  /** Given for a ledger that is read in place from another directory; else the manifest of `dir` has it under `name`. */
  inPlace?: CaseRef;
  /** The transaction's `TransactionResult`. */
  result: string;
  /** Which field of the transaction names the account: its sender (`Account`) or its recipient (`Destination`). */
  role: 'Account' | 'Destination';
  account: string;
  /** The Domain after the transaction (`FinalFields.Domain`), upper-case hex. */
  domain_hex: string;
  /** The position of the account's root in `meta.AffectedNodes`. */
  node_index: number;
}

/** The ledgers of `dir` (all of them, or only these indexes) as the parser reads them. */
function ledgersOf(dir: string, only?: number[]): RawLedger[] {
  const all = FixtureLedgerSource.fromDir(join(FIXTURES, dir)).list();
  return only === undefined ? all : all.filter((l) => only.includes(l.header.ledger_index));
}

/** The `cases` object of the manifest of `dir`. */
function manifestCases(dir: string): Record<string, CaseRef & { note: string }> {
  return JSON.parse(readFileSync(join(FIXTURES, dir, 'manifest.json'), 'utf8')).cases;
}

function refOf(c: DomainCase): CaseRef {
  const ref = c.inPlace ?? manifestCases(c.dir)[c.name];
  if (!ref) throw new Error(`${c.dir}/manifest.json has no case "${c.name}"`);
  return ref;
}

interface Network {
  name: 'xrpl' | 'xahau';
  database: string;
  /** The ledgers to write: every ledger of the network's `account-domains` directory (Xahau has none), and the ones read in place. */
  ledgers: () => RawLedger[];
  cases: DomainCase[];
}

const NETWORKS: Network[] = [
  {
    name: 'xrpl',
    database: 'domains_xrpl',
    ledgers: () => [
      ...ledgersOf('xrpl/account-domains'),
      ...ledgersOf('xrpl/recorded', [107671317]),
      ...ledgersOf('xrpl/amm', [106084525]),
      ...ledgersOf('xrpl/path-payments', [37999837]),
    ],
    cases: [
      {
        name: 'accountset_sets_domain',
        dir: 'xrpl/account-domains',
        result: 'tesSUCCESS',
        role: 'Account',
        account: 'rM8kmmnz5qPMg7V3r7SHYXgDGvm8PhzLvM',
        // lumitrades.io
        domain_hex: '6C756D697472616465732E696F',
        node_index: 0,
      },
      {
        name: 'accountset_changes_domain',
        dir: 'xrpl/account-domains',
        result: 'tesSUCCESS',
        role: 'Account',
        account: 'rPo76joT4HVuvyomAqnapVcX3tYvmAxhHT',
        // 9437D5204E1F5CAF200A26E3862B86DC560E84EDB7D5EC2679225E723802BAE5 before
        domain_hex: '339D2BF5E0AEE68CACBE6BE3DAF3F96F4B9BC3FE208699286AD5B4C746FE2DEF',
        node_index: 0,
      },
      // A Payment received by an account with a Domain (test.com): ledger 107671317 of `xrpl/recorded`.
      {
        name: 'payment_to_account_with_domain',
        dir: 'xrpl/recorded',
        inPlace: {
          ledger: 107671317,
          hash: 'B244AF0904E22964D1AF89FD213AA8502ADF65FEED95185C6B62961DB9DC2571',
          type: 'Payment',
        },
        result: 'tesSUCCESS',
        role: 'Destination',
        account: 'rf82s1CDagppvM6ATqc1nSrL6GackzHJrm',
        domain_hex: '746573742E636F6D',
        node_index: 0,
      },
      // A failed Payment of a sender with a Domain (https://www.smartplaystudio.com/): ledger 106084525 of `xrpl/amm`.
      {
        name: 'failed_tx_with_domain',
        dir: 'xrpl/amm',
        inPlace: {
          ledger: 106084525,
          hash: '1531CDE5DA5E231C54B7A697FD7C1C51151E8AB2AD3D1FB5174A571E63C2E280',
          type: 'Payment',
        },
        result: 'tecPATH_PARTIAL',
        role: 'Account',
        account: 'r428GGG2F1vgn9BUtuiCiEmzrh5oAnhyj7',
        domain_hex: '68747470733A2F2F7777772E736D617274706C617973747564696F2E636F6D2F',
        node_index: 0,
      },
      // A failed OfferCreate of a sender with a Domain (mduo13.com), the last of three transactions that touch it: ledger
      // 37999837 of `xrpl/path-payments`.
      {
        name: 'failed_tx_with_domain',
        dir: 'xrpl/path-payments',
        inPlace: {
          ledger: 37999837,
          hash: 'B28614B78D1D90B34081F74B6EC5A76C6898800A51B69ED19280F918B743A50E',
          type: 'OfferCreate',
        },
        result: 'tecUNFUNDED_OFFER',
        role: 'Account',
        account: 'r9Gps6fB9YLuZ87rWx7M9TgLAGK2zsz5s6',
        domain_hex: '6D64756F31332E636F6D',
        node_index: 0,
      },
    ],
  },
  {
    name: 'xahau',
    database: 'domains_xahau',
    ledgers: () => [...ledgersOf('xahau/recorded', [26540187, 26540711])],
    cases: [
      // A Payment sent by an account with a Domain (n1737.bisdaknode1701-1750.ovh): the change is on the sender's own root
      // (`Sequence` is in its `PreviousFields`), not on the recipient's. Ledger 26540187 of `xahau/recorded`.
      {
        name: 'payment_by_account_with_domain',
        dir: 'xahau/recorded',
        inPlace: {
          ledger: 26540187,
          hash: '00F5098EB67BB5E4E177D02F5B492DD5BF215DFF1677EFBD8542394387EBC866',
          type: 'Payment',
        },
        result: 'tesSUCCESS',
        role: 'Account',
        account: 'rGsbGtyrXoPSocAWcngrQZqm6AaQmocw5B',
        domain_hex: '6E313733372E62697364616B6E6F6465313730312D313735302E6F7668',
        node_index: 2,
      },
    ],
  },
];

/** The newest row of an account: what the tomls worker and the names batch read (`argMax` by `version`). */
interface Newest {
  newest_hex: string;
  newest_deleted: number;
  newest_version: string;
}

describe('account_domains from recorded ledgers (e2e)', () => {
  let ch: StartedClickHouse;

  beforeAll(async () => {
    ch = await startClickHouse();
  });

  afterAll(async () => {
    await ch?.container.stop();
  });

  describe.each(NETWORKS)('$name', (network) => {
    let svc: ClickHouseService;
    let ledgers: RawLedger[];
    const ctx = parseContextFor(getNetworkProfile(network.name));

    beforeAll(async () => {
      const config = { ...ch.config, database: network.database };
      await runMigrations({ config, log: () => undefined });
      svc = new ClickHouseService(config);
      ledgers = network.ledgers();
      await new LedgerWriter(svc, ctx).write(ledgers);
    });

    afterAll(async () => {
      await svc?.close();
    });

    async function newest(account: string): Promise<Newest | undefined> {
      return svc.queryOne<Newest>(
        `SELECT argMax(domain_hex, version) AS newest_hex, argMax(deleted, version) AS newest_deleted,
                max(version) AS newest_version
           FROM ${Table.AccountDomains} WHERE account = {account:String} GROUP BY account`,
        { account },
        READ_SETTINGS,
      );
    }

    /** The newest row of every account, in account order: the table as every reader sees it. */
    async function currentDomains(): Promise<Array<Newest & { account: string }>> {
      return svc.query(
        `SELECT account, argMax(domain_hex, version) AS newest_hex, argMax(deleted, version) AS newest_deleted,
                max(version) AS newest_version
           FROM ${Table.AccountDomains} GROUP BY account ORDER BY account`,
        {},
        READ_SETTINGS,
      );
    }

    function transactionOf(ref: CaseRef): RawTransaction {
      const ledger = ledgers.find((l) => l.header.ledger_index === ref.ledger);
      const tx = ledger?.transactions.find((t) => t.hash === ref.hash);
      if (!tx) throw new Error(`ledger ${ref.ledger} does not hold transaction ${ref.hash}`);
      return tx;
    }

    it.each(network.cases.map((c) => [`${c.name} (${c.dir})`, c] as const))(
      '%s: the newest row of the account is what the ledger says',
      async (_label, c) => {
        const ref = refOf(c);
        const tx = transactionOf(ref);
        // The fixture is the case: the transaction the manifest names, and the account where the case says it is.
        expect(tx.tx.TransactionType).toBe(ref.type);
        expect(tx.meta.TransactionResult).toBe(c.result);
        expect(tx.tx[c.role]).toBe(c.account);
        const node = (tx.meta.AffectedNodes as Json[])[c.node_index];
        const [, body] = Object.entries(node)[0] as [string, Json];
        expect(body.LedgerEntryType).toBe('AccountRoot');
        expect(body.FinalFields.Account).toBe(c.account);
        expect(body.FinalFields.Domain).toBe(c.domain_hex);

        // The row of that very node is the newest one of the account: no later transaction of the ledgers touched it.
        expect(await newest(c.account)).toEqual({
          newest_hex: c.domain_hex,
          newest_deleted: 0,
          newest_version: accountDomainVersion(ref.ledger, tx.meta.TransactionIndex as number, c.node_index),
        });
      },
    );

    if (network.name === 'xahau') {
      it('the 14 AccountSets of ledger 26540711 that change a Domain leave the Domain they wrote', async () => {
        const ledger = ledgers.find((l) => l.header.ledger_index === 26540711);
        if (!ledger) throw new Error('ledger 26540711 is not among the written ledgers');
        // Read straight off the metadata: the sender's root, with a Domain before and another one after.
        const changes = ledger.transactions.flatMap((t) =>
          (t.meta.AffectedNodes as Json[]).flatMap((node, node_index) => {
            const body: Json | undefined = node.ModifiedNode;
            const before = body?.PreviousFields?.Domain;
            const after = body?.FinalFields?.Domain;
            const changed =
              t.tx.TransactionType === 'AccountSet' &&
              t.meta.TransactionResult === 'tesSUCCESS' &&
              body?.LedgerEntryType === 'AccountRoot' &&
              body.FinalFields.Account === t.tx.Account &&
              typeof before === 'string' &&
              typeof after === 'string' &&
              before !== after;
            return changed
              ? [
                  {
                    account: t.tx.Account as string,
                    newest_hex: after as string,
                    newest_deleted: 0,
                    newest_version: accountDomainVersion(26540711, t.meta.TransactionIndex as number, node_index),
                  },
                ]
              : [];
          }),
        );
        expect(changes).toHaveLength(14);

        const accounts = changes.map((c) => c.account);
        const stored = await svc.query(
          `SELECT account, argMax(domain_hex, version) AS newest_hex, argMax(deleted, version) AS newest_deleted,
                  max(version) AS newest_version
             FROM ${Table.AccountDomains} WHERE account IN {accounts:Array(String)} GROUP BY account ORDER BY account`,
          { accounts },
          READ_SETTINGS,
        );
        expect(stored).toEqual([...changes].sort((a, b) => (a.account < b.account ? -1 : 1)));
      });
    }

    it('comes back the same after a ledger is deleted and written again', async () => {
      const before = await currentDomains();
      expect(before.length).toBeGreaterThan(0);
      // The newest ledger of the cases: the rows of its transactions are the newest of their accounts.
      const ledger = Math.max(...network.cases.map((c) => refOf(c).ledger));
      const rowsOf = async (table: Table): Promise<number> =>
        Number(
          (
            await svc.queryOne<{ n: string }>(
              `SELECT count() AS n FROM ${table} WHERE ledger_index = {ledger:UInt32}`,
              { ledger },
              READ_SETTINGS,
            )
          )?.n,
        );
      expect(await rowsOf(Table.AccountDomains)).toBeGreaterThan(0);

      await deleteLedgerRange(svc, ledger, ledger);
      expect([await rowsOf(Table.Ledgers), await rowsOf(Table.AccountDomains)]).toEqual([0, 0]);
      expect(await currentDomains()).not.toEqual(before);

      await new LedgerWriter(svc, ctx).write(ledgers.filter((l) => l.header.ledger_index === ledger));
      expect(await currentDomains()).toEqual(before);
    });
  });
});
