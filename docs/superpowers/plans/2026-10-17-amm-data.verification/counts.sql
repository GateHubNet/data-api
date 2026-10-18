select 'ledgers' t, count() c from xrpl.ledgers where ledger_index between 107734981 and 107734999
union all select 'transactions', count() from xrpl.transactions where ledger_index between 107734981 and 107734999
union all select 'exchanges', count() from xrpl.exchanges where ledger_index between 107734981 and 107734999
union all select 'exchanges_amm', count() from xrpl.exchanges where amm_account != '' and ledger_index between 107734981 and 107734999
union all select 'amm_pool_states', count() from xrpl.amm_pool_states where ledger_index between 107734981 and 107734999
union all select 'amm_pool_touches', count() from xrpl.amm_pool_touches where ledger_index between 107734981 and 107734999
union all select 'amm_liquidity', count() from xrpl.amm_liquidity where ledger_index between 107734981 and 107734999
union all select 'amm_governance', count() from xrpl.amm_governance where ledger_index between 107734981 and 107734999
union all select 'account_amm_liquidity', count() from xrpl.account_amm_liquidity where ledger_index between 107734981 and 107734999
union all select 'account_exchanges', count() from xrpl.account_exchanges where ledger_index between 107734981 and 107734999
format TSV
