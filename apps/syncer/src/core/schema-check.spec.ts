import { ClickHouseService, Table } from '@gatehub/data-api-shared';
import { WorkerName } from '../config/syncer.config';
import { assertTomlsSchema, assertValidatorsSchema, TOMLS_MIGRATION, VALIDATORS_MIGRATION } from './schema-check';

/** The columns of `system.columns` a database has, as `table.column`. */
const ALL_OF_002 = [
  `${Table.Validations}.server_version`,
  `${Table.ValidatorManifests}.domain`,
  `${Table.ValidatorManifests}.manifest`,
  `${Table.ValidatorManifests}.source`,
  ...[
    Table.ValidatorValidations,
    Table.ValidatorSeen,
    Table.UnlLists,
    Table.UnlPublishers,
    Table.ValidatorDomains,
    Table.NetworkState,
    Table.AmendmentFeatures,
    Table.ValidatorVotes,
    Table.AmendmentTallies,
    Table.ValidatorAgreementHourly,
  ].map((table) => `${table}.some_column`),
  `${Table.Validations}.ledger_hash`,
  `${Table.ValidatorManifests}.ephemeral_key`,
];

function database(columns: string[]) {
  const query = jest.fn(async (_sql: string, params?: Record<string, unknown>) =>
    columns
      .map((each) => each.split('.'))
      .filter(([table]) => (params?.tables as string[]).includes(table))
      .map(([table, name]) => ({ column_table: table, column_name: name })),
  );
  return { query, ch: { query } as unknown as Pick<ClickHouseService, 'query'> };
}

const workers = (...names: WorkerName[]) => new Set<WorkerName>(names);

describe('assertValidatorsSchema', () => {
  it('checks nothing when neither the validations nor the validators worker is enabled', async () => {
    const db = database([]);
    const warn = jest.fn();
    await assertValidatorsSchema(db.ch, workers('ingest', 'aggregator', 'fee_stats'), 'xrpl', { warn });
    await assertValidatorsSchema(db.ch, workers(), 'xrpl', { warn });
    expect(db.query).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('passes a database with the schema of 002, reading system.columns of the database with bound values', async () => {
    const db = database(ALL_OF_002);
    await expect(assertValidatorsSchema(db.ch, workers('validations'), 'xrpl', { warn: jest.fn() })).resolves.toBe(
      undefined,
    );
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('FROM system.columns');
    expect(sql).toContain('database = currentDatabase()');
    expect(params?.tables).toEqual(expect.arrayContaining([Table.Validations, Table.ValidatorAgreementHourly]));
  });

  it.each([['validations'], ['validators']] as [WorkerName][])(
    'fails the boot of the %s worker on a database of 001 alone, naming 002_validators_amendments.sql',
    async (worker) => {
      const db = database([`${Table.Validations}.ledger_hash`, `${Table.ValidatorManifests}.ephemeral_key`]);
      const check = assertValidatorsSchema(db.ch, workers(worker, 'ingest'), 'xrpl', { warn: jest.fn() });
      await expect(check).rejects.toThrow(VALIDATORS_MIGRATION);
      await expect(check).rejects.toThrow(`column ${Table.Validations}.server_version`);
      await expect(check).rejects.toThrow(`table ${Table.ValidatorSeen}`);
      await expect(check).rejects.toThrow(`the ${worker} worker writes`);
      await expect(check).rejects.toThrow('database "xrpl"');
    },
  );

  it('names exactly what is missing of a 002 applied half way', async () => {
    const half = ALL_OF_002.filter(
      (each) => each !== `${Table.ValidatorManifests}.source` && !each.startsWith(`${Table.ValidatorAgreementHourly}.`),
    );
    await expect(
      assertValidatorsSchema(database(half).ch, workers('validations', 'validators'), 'xahau', { warn: jest.fn() }),
    ).rejects.toThrow(
      `(column ${Table.ValidatorManifests}.source, table ${Table.ValidatorAgreementHourly}), which the validations and ` +
        'validators workers write',
    );
  });

  it('does not fail the boot when the check cannot be made, and says so', async () => {
    const ch = {
      query: jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8123')),
    } as unknown as Pick<ClickHouseService, 'query'>;
    const warn = jest.fn();
    await expect(assertValidatorsSchema(ch, workers('validators'), 'xrpl', { warn })).resolves.toBe(undefined);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(VALIDATORS_MIGRATION));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
  });
});

/** A database that has the tables, as `system.tables` would list the ones asked for. */
function tablesOf(...have: string[]) {
  const query = jest.fn(async (_sql: string, params?: Record<string, unknown>) =>
    have.filter((table) => (params?.tables as string[]).includes(table)).map((table) => ({ table_name: table })),
  );
  return { query, ch: { query } as unknown as Pick<ClickHouseService, 'query'> };
}

describe('assertTomlsSchema', () => {
  it('checks nothing when the tomls worker is not enabled', async () => {
    const db = tablesOf();
    const warn = jest.fn();
    await assertTomlsSchema(db.ch, workers('ingest', 'validators', 'aggregator'), 'xrpl', { warn });
    await assertTomlsSchema(db.ch, workers(), 'xrpl', { warn });
    expect(db.query).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('passes a database with the two tables of 012, reading system.tables of the database with bound values', async () => {
    const db = tablesOf(Table.AccountDomains, Table.DomainTomls);
    await expect(assertTomlsSchema(db.ch, workers('tomls'), 'xrpl', { warn: jest.fn() })).resolves.toBe(undefined);
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('FROM system.tables');
    expect(sql).toContain('database = currentDatabase()');
    expect(params).toEqual({ tables: [Table.AccountDomains, Table.DomainTomls] });
  });

  it('fails the boot of the tomls worker on a database without 012, naming the migration and both tables', async () => {
    const check = assertTomlsSchema(tablesOf(Table.Ledgers).ch, workers('tomls', 'ingest'), 'xahau', {
      warn: jest.fn(),
    });
    await expect(check).rejects.toThrow(TOMLS_MIGRATION);
    expect(TOMLS_MIGRATION).toBe('012_display_names.sql');
    await expect(check).rejects.toThrow(`table ${Table.AccountDomains}, table ${Table.DomainTomls}`);
    await expect(check).rejects.toThrow('the tomls worker reads and writes');
    await expect(check).rejects.toThrow('database "xahau"');
  });

  it('names exactly the table that is missing', async () => {
    const check = assertTomlsSchema(tablesOf(Table.AccountDomains).ch, workers('tomls'), 'xrpl', { warn: jest.fn() });
    await expect(check).rejects.toThrow(`(table ${Table.DomainTomls})`);
  });

  it('does not fail the boot when the check cannot be made, and says so', async () => {
    const ch = {
      query: jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8123')),
    } as unknown as Pick<ClickHouseService, 'query'>;
    const warn = jest.fn();
    await expect(assertTomlsSchema(ch, workers('tomls'), 'xrpl', { warn })).resolves.toBe(undefined);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(TOMLS_MIGRATION));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
  });
});
