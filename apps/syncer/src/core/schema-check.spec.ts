import { ClickHouseService, Table } from '@gatehub/data-api-shared';
import { WorkerName } from '../config/syncer.config';
import {
  assertIssuedTokensSchema,
  assertMptSchema,
  assertSupplySchema,
  assertTomlsSchema,
  assertValidatorsSchema,
  assertValidatorTomlSchema,
  ISSUED_TOKENS_MIGRATION,
  MPT_MIGRATION,
  SUPPLY_MIGRATION,
  TOMLS_MIGRATION,
  VALIDATOR_TOML_MIGRATION,
  VALIDATORS_MIGRATION,
} from './schema-check';

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

describe('assertIssuedTokensSchema', () => {
  const FOUR = [Table.StateTouches, Table.TokenGenerations, Table.TokenLines, Table.Tokens];

  it('checks nothing when neither the ingest nor the aggregator worker is enabled', async () => {
    const db = tablesOf();
    const warn = jest.fn();
    await assertIssuedTokensSchema(db.ch, workers('validations', 'fee_stats', 'validators', 'tomls'), 'xrpl', { warn });
    await assertIssuedTokensSchema(db.ch, workers(), 'xrpl', { warn });
    expect(db.query).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('passes a database with the four tables of 014, reading system.tables of the database with bound values', async () => {
    const db = tablesOf(...FOUR);
    await expect(
      assertIssuedTokensSchema(db.ch, workers('ingest', 'aggregator'), 'xrpl', { warn: jest.fn() }),
    ).resolves.toBe(undefined);
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('FROM system.tables');
    expect(sql).toContain('database = currentDatabase()');
    expect(params).toEqual({ tables: FOUR });
  });

  it('asks the ingest worker for state_touches alone, and the aggregator worker for all four', async () => {
    const ingest = tablesOf(Table.StateTouches);
    await expect(
      assertIssuedTokensSchema(ingest.ch, workers('ingest', 'tomls'), 'xrpl', { warn: jest.fn() }),
    ).resolves.toBe(undefined);
    expect(ingest.query.mock.calls[0][1]).toEqual({ tables: [Table.StateTouches] });

    const aggregator = tablesOf(...FOUR);
    await expect(
      assertIssuedTokensSchema(aggregator.ch, workers('aggregator'), 'xrpl', { warn: jest.fn() }),
    ).resolves.toBe(undefined);
    expect(aggregator.query.mock.calls[0][1]).toEqual({ tables: FOUR });
  });

  it('fails the boot of the ingest worker on a database without 014, naming the migration and state_touches', async () => {
    const check = assertIssuedTokensSchema(tablesOf(Table.Ledgers).ch, workers('ingest', 'fee_stats'), 'xahau', {
      warn: jest.fn(),
    });
    await expect(check).rejects.toThrow(ISSUED_TOKENS_MIGRATION);
    expect(ISSUED_TOKENS_MIGRATION).toBe('014_issued_tokens.sql');
    await expect(check).rejects.toThrow(`(table ${Table.StateTouches})`);
    await expect(check).rejects.toThrow('the ingest worker writes');
    await expect(check).rejects.toThrow('database "xahau"');
    await expect(check).rejects.toThrow('apply the migrations');
  });

  it('fails the boot of the aggregator worker on a database without 014, naming all four tables', async () => {
    const check = assertIssuedTokensSchema(tablesOf(Table.Ledgers).ch, workers('aggregator'), 'xrpl', {
      warn: jest.fn(),
    });
    await expect(check).rejects.toThrow(
      `(table ${Table.StateTouches}, table ${Table.TokenGenerations}, table ${Table.TokenLines}, table ${Table.Tokens})`,
    );
    await expect(check).rejects.toThrow('the aggregator worker reads and writes');
  });

  it('names both workers when both are enabled', async () => {
    const check = assertIssuedTokensSchema(tablesOf().ch, workers('ingest', 'aggregator'), 'xrpl', { warn: jest.fn() });
    await expect(check).rejects.toThrow('the ingest worker writes and the aggregator worker reads and writes');
  });

  it('names exactly the tables that are missing', async () => {
    const half = tablesOf(Table.StateTouches, Table.TokenGenerations);
    const check = assertIssuedTokensSchema(half.ch, workers('aggregator'), 'xrpl', { warn: jest.fn() });
    await expect(check).rejects.toThrow(`(table ${Table.TokenLines}, table ${Table.Tokens})`);
    // the ingest worker does not need the aggregates: the same database lets it start
    await expect(assertIssuedTokensSchema(half.ch, workers('ingest'), 'xrpl', { warn: jest.fn() })).resolves.toBe(
      undefined,
    );
  });

  it('does not fail the boot when the check cannot be made, and says so', async () => {
    const ch = {
      query: jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8123')),
    } as unknown as Pick<ClickHouseService, 'query'>;
    const warn = jest.fn();
    await expect(assertIssuedTokensSchema(ch, workers('aggregator'), 'xrpl', { warn })).resolves.toBe(undefined);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(ISSUED_TOKENS_MIGRATION));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
  });
});

describe('assertValidatorTomlSchema', () => {
  const COLUMNS = ['owner_country', 'server_country', 'toml_network', 'toml_unl', 'toml_version'];
  const ALL_OF_016 = COLUMNS.map((column) => `${Table.ValidatorDomains}.${column}`);

  it('checks nothing without the validators worker', async () => {
    const db = database([]);
    const warn = jest.fn();
    await assertValidatorTomlSchema(db.ch, workers('validations', 'ingest', 'aggregator', 'tomls'), 'xrpl', { warn });
    await assertValidatorTomlSchema(db.ch, workers(), 'xrpl', { warn });
    expect(db.query).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('passes a database with the five columns, reading system.columns of the database with bound values', async () => {
    const db = database(ALL_OF_016);
    await expect(assertValidatorTomlSchema(db.ch, workers('validators'), 'xrpl', { warn: jest.fn() })).resolves.toBe(
      undefined,
    );
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('FROM system.columns');
    expect(sql).toContain('database = currentDatabase()');
    expect(params).toEqual({ tables: [Table.ValidatorDomains] });
  });

  it('fails the boot naming the file, the database, the worker and each column that is missing', async () => {
    const half = database(ALL_OF_016.filter((c) => !c.endsWith('toml_unl') && !c.endsWith('toml_version')));
    const check = assertValidatorTomlSchema(half.ch, workers('validators', 'ingest'), 'xahau', { warn: jest.fn() });
    await expect(check).rejects.toThrow(
      `The ClickHouse database "xahau" lacks the schema of ${VALIDATOR_TOML_MIGRATION} ` +
        `(column ${Table.ValidatorDomains}.toml_unl, column ${Table.ValidatorDomains}.toml_version), which the validators worker reads and writes`,
    );
    await expect(check).rejects.toThrow('ch:migrate');
  });

  it('does not fail the boot when the check cannot be made, and says so', async () => {
    const ch = {
      query: jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8123')),
    } as unknown as Pick<ClickHouseService, 'query'>;
    const warn = jest.fn();
    await expect(assertValidatorTomlSchema(ch, workers('validators'), 'xrpl', { warn })).resolves.toBe(undefined);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(VALIDATOR_TOML_MIGRATION));
  });

  it('names 016', () => {
    expect(VALIDATOR_TOML_MIGRATION).toBe('016_validator_toml_details.sql');
  });
});

describe('assertSupplySchema', () => {
  const MINT_TABLES = [Table.GenesisMints, Table.Imports, Table.RewardClaims];
  const ALL_TABLES = [...MINT_TABLES, Table.NetworkSupply];

  it('checks nothing when neither the ingest nor the aggregator worker is enabled', async () => {
    const db = tablesOf();
    const warn = jest.fn();
    await assertSupplySchema(db.ch, workers('validations', 'fee_stats', 'validators', 'tomls'), 'xahau', { warn });
    await assertSupplySchema(db.ch, workers(), 'xahau', { warn });
    expect(db.query).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('passes a database with the three mint tables of 015 for the ingest, reading system.tables of the database with bound values', async () => {
    const db = tablesOf(...MINT_TABLES);
    await expect(assertSupplySchema(db.ch, workers('ingest'), 'xahau', { warn: jest.fn() })).resolves.toBe(undefined);
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('FROM system.tables');
    expect(sql).toContain('database = currentDatabase()');
    expect(params).toEqual({ tables: MINT_TABLES });
  });

  it('passes a database with the four tables of 015 for the aggregator, and for both workers', async () => {
    const db = tablesOf(...ALL_TABLES);
    await expect(assertSupplySchema(db.ch, workers('aggregator'), 'xrpl', { warn: jest.fn() })).resolves.toBe(
      undefined,
    );
    expect(db.query.mock.calls[0][1]).toEqual({ tables: ALL_TABLES });
    await expect(
      assertSupplySchema(db.ch, workers('ingest', 'aggregator'), 'xahau', { warn: jest.fn() }),
    ).resolves.toBe(undefined);
    // both workers ask once, for the tables of both, each named once
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query.mock.calls[1][1]).toEqual({ tables: ALL_TABLES });
  });

  it('fails the boot of the ingest worker on a database without 015, naming the migration and the three tables, on either network', async () => {
    for (const database of ['xahau', 'xrpl']) {
      const check = assertSupplySchema(
        tablesOf(Table.Ledgers, Table.StateTouches).ch,
        workers('ingest', 'fee_stats'),
        database,
        {
          warn: jest.fn(),
        },
      );
      await expect(check).rejects.toThrow(SUPPLY_MIGRATION);
      await expect(check).rejects.toThrow(
        `(table ${Table.GenesisMints}, table ${Table.Imports}, table ${Table.RewardClaims})`,
      );
      await expect(check).rejects.toThrow('the ingest worker writes');
      await expect(check).rejects.toThrow(`database "${database}"`);
      await expect(check).rejects.toThrow('apply the migrations');
    }
    expect(SUPPLY_MIGRATION).toBe('015_supply.sql');
  });

  it('fails the boot of the aggregator worker on a database without 015, naming the migration and the four tables, on either network', async () => {
    for (const database of ['xahau', 'xrpl']) {
      const check = assertSupplySchema(
        tablesOf(Table.Ledgers, Table.StateTouches).ch,
        workers('aggregator', 'fee_stats'),
        database,
        { warn: jest.fn() },
      );
      await expect(check).rejects.toThrow(SUPPLY_MIGRATION);
      await expect(check).rejects.toThrow(
        `(table ${Table.GenesisMints}, table ${Table.Imports}, table ${Table.RewardClaims}, table ${Table.NetworkSupply})`,
      );
      await expect(check).rejects.toThrow('the aggregator worker reads and writes');
      await expect(check).rejects.not.toThrow('the ingest worker');
      await expect(check).rejects.toThrow(`database "${database}"`);
    }
  });

  it('names the tables once, and what each worker does, when the ingest and the aggregator are both enabled', async () => {
    const check = assertSupplySchema(tablesOf().ch, workers('ingest', 'aggregator'), 'xahau', { warn: jest.fn() });
    await expect(check).rejects.toThrow(
      `(table ${Table.GenesisMints}, table ${Table.Imports}, table ${Table.RewardClaims}, table ${Table.NetworkSupply}), ` +
        'which the ingest worker writes and the aggregator worker reads and writes',
    );
  });

  it('names exactly the tables that are missing', async () => {
    const check = assertSupplySchema(tablesOf(Table.GenesisMints).ch, workers('ingest'), 'xahau', { warn: jest.fn() });
    await expect(check).rejects.toThrow(`(table ${Table.Imports}, table ${Table.RewardClaims})`);
    await expect(check).rejects.not.toThrow(`table ${Table.GenesisMints}`);
    // the aggregator with the mint tables and not the snapshot table: only the snapshot table is named
    const aggregator = assertSupplySchema(tablesOf(...MINT_TABLES).ch, workers('aggregator'), 'xrpl', {
      warn: jest.fn(),
    });
    await expect(aggregator).rejects.toThrow(`(table ${Table.NetworkSupply})`);
  });

  it('is a check of its own: a database with the tables of 014 and not 015 passes 014 and fails 015, each naming its own file', async () => {
    const db = tablesOf(Table.StateTouches, Table.TokenGenerations, Table.TokenLines, Table.Tokens);
    await expect(
      assertIssuedTokensSchema(db.ch, workers('ingest', 'aggregator'), 'xahau', { warn: jest.fn() }),
    ).resolves.toBe(undefined);
    const check = assertSupplySchema(db.ch, workers('ingest', 'aggregator'), 'xahau', { warn: jest.fn() });
    await expect(check).rejects.toThrow(SUPPLY_MIGRATION);
    await expect(check).rejects.not.toThrow(ISSUED_TOKENS_MIGRATION);
  });

  it('does not fail the boot when the check cannot be made, and says so', async () => {
    const ch = {
      query: jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8123')),
    } as unknown as Pick<ClickHouseService, 'query'>;
    const warn = jest.fn();
    await expect(assertSupplySchema(ch, workers('ingest'), 'xahau', { warn })).resolves.toBe(undefined);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(SUPPLY_MIGRATION));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the ingest worker starts without the check'));
    await expect(assertSupplySchema(ch, workers('aggregator'), 'xrpl', { warn })).resolves.toBe(undefined);
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('the aggregator worker starts without the check'));
  });
});

describe('assertMptSchema', () => {
  const MPT_LEDGER_TABLES = [
    Table.MptIssuanceStates,
    Table.MptHolderStates,
    Table.MptTouches,
    Table.MptTransfers,
    Table.MptIssuanceTransfers,
  ];
  const MPT_AGGREGATOR_TABLES = [
    Table.MptIssuanceStates,
    Table.MptHolderStates,
    Table.MptTouches,
    Table.MptIssuances,
    Table.MptHolders,
  ];

  it('checks nothing when neither the ingest nor the aggregator worker is enabled', async () => {
    const db = tablesOf();
    const warn = jest.fn();
    await assertMptSchema(db.ch, workers('validations', 'fee_stats', 'validators', 'tomls'), 'xrpl', {
      warn,
    });
    await assertMptSchema(db.ch, workers(), 'xrpl', { warn });
    expect(db.query).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('passes a database with the five ledger tables of 017 for the ingest, reading system.tables with bound values', async () => {
    const db = tablesOf(...MPT_LEDGER_TABLES);
    await expect(assertMptSchema(db.ch, workers('ingest'), 'xrpl', { warn: jest.fn() })).resolves.toBe(undefined);
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('FROM system.tables');
    expect(sql).toContain('database = currentDatabase()');
    expect(params).toEqual({ tables: MPT_LEDGER_TABLES });
  });

  it('fails the boot of the ingest worker on a database without 017, naming the migration and the five tables, on every network', async () => {
    for (const database of ['xrpl', 'xrpl_testnet', 'xahau', 'xahau_testnet']) {
      const check = assertMptSchema(tablesOf(Table.Ledgers).ch, workers('ingest', 'fee_stats'), database, {
        warn: jest.fn(),
      });
      await expect(check).rejects.toThrow(MPT_MIGRATION);
      await expect(check).rejects.toThrow(
        `(table ${Table.MptIssuanceStates}, table ${Table.MptHolderStates}, table ${Table.MptTouches}, ` +
          `table ${Table.MptTransfers}, table ${Table.MptIssuanceTransfers})`,
      );
      await expect(check).rejects.toThrow('the ingest worker writes');
      await expect(check).rejects.toThrow(`database "${database}"`);
      await expect(check).rejects.toThrow('apply the migrations');
    }
    expect(MPT_MIGRATION).toBe('017_mpt.sql');
  });

  it('passes a database with the tables the mpt_state job needs for the aggregator, reading only those', async () => {
    const db = tablesOf(...MPT_AGGREGATOR_TABLES);
    await expect(assertMptSchema(db.ch, workers('aggregator'), 'xrpl', { warn: jest.fn() })).resolves.toBe(undefined);
    expect(db.query.mock.calls[0][1]).toEqual({ tables: MPT_AGGREGATOR_TABLES });
  });

  it('fails the boot of the aggregator worker on a database without 017, naming the tables it reads and writes, on every network', async () => {
    for (const database of ['xrpl', 'xrpl_testnet', 'xahau', 'xahau_testnet']) {
      const check = assertMptSchema(tablesOf(Table.Ledgers).ch, workers('aggregator'), database, { warn: jest.fn() });
      await expect(check).rejects.toThrow(MPT_MIGRATION);
      await expect(check).rejects.toThrow(
        `(table ${Table.MptIssuanceStates}, table ${Table.MptHolderStates}, table ${Table.MptTouches}, ` +
          `table ${Table.MptIssuances}, table ${Table.MptHolders})`,
      );
      await expect(check).rejects.toThrow('the aggregator worker reads and writes');
      await expect(check).rejects.toThrow(`database "${database}"`);
    }
  });

  it('names exactly the tables that are missing', async () => {
    const check = assertMptSchema(tablesOf(Table.MptTouches).ch, workers('ingest'), 'xrpl', { warn: jest.fn() });
    await expect(check).rejects.toThrow(
      `(table ${Table.MptIssuanceStates}, table ${Table.MptHolderStates}, table ${Table.MptTransfers}, table ${Table.MptIssuanceTransfers})`,
    );
    await expect(check).rejects.not.toThrow(`table ${Table.MptTouches}`);
  });

  it('is a check of its own: a database with the tables of 015 and not 017 passes 015 and fails 017, each naming its own file', async () => {
    const db = tablesOf(Table.GenesisMints, Table.Imports, Table.RewardClaims, Table.NetworkSupply);
    await expect(assertSupplySchema(db.ch, workers('ingest'), 'xrpl', { warn: jest.fn() })).resolves.toBe(undefined);
    const check = assertMptSchema(db.ch, workers('ingest'), 'xrpl', { warn: jest.fn() });
    await expect(check).rejects.toThrow(MPT_MIGRATION);
    await expect(check).rejects.not.toThrow(SUPPLY_MIGRATION);
  });

  it('does not fail the boot when the check cannot be made, and says so', async () => {
    const ch = {
      query: jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8123')),
    } as unknown as Pick<ClickHouseService, 'query'>;
    const warn = jest.fn();
    await expect(assertMptSchema(ch, workers('ingest'), 'xrpl', { warn })).resolves.toBe(undefined);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(MPT_MIGRATION));
  });
});
