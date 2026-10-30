import { Get } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { SupplyAnswer } from './supply-object';
import { SupplyService } from './supply.service';

/**
 * `GET /v2/network/supply` (spec 5.1): the native supply of the network at the newest snapshot of the syncer's `supply` job, one an
 * hour. A new route: its object and key order are ours (`supply-object.ts`), and it uses the contract layer of the others (the API
 * key, the rate limit, `GH_CACHE_CONTROL`, errors `{result: "error", message}`). It takes no parameter; the ones sent are ignored.
 */
@RippleController('v2/network/supply')
export class SupplyController {
  constructor(private readonly supply: SupplyService) {}

  @Get()
  @RippleRoute('unable to retrieve supply')
  @ApiOperation({
    summary: 'Get the supply of the native currency',
    description:
      'The newest hourly snapshot of the native supply: every figure is as of one ledger (`ledger_index`, `close_time`), ' +
      'computed at `computed_at`, and an exact decimal text in whole units. `total` is the currency in existence. `burned` is ' +
      'what was destroyed: on the XRP Ledger 100 billion XRP less the total, exact from the ledger header, and on Xahau the ' +
      'fees of the indexed ledgers (no cap). `minted` (Xahau) is what was created by the indexed ledgers, `amount` being the sum ' +
      'of `rewards` (the rewards claimed), `import` (what an Import credited) and `genesis_mint` (every other GenesisMint). ' +
      '`escrowed` is the native currency in open escrows, `circulating` the total less the escrowed, which counts what is in ' +
      'payment channels, in AMM pools and held as reserves. `amm` (the XRP Ledger) is the native currency in the pools of ' +
      'automated market makers, and `reserves` the least the accounts must keep: the accounts times the base reserve plus ' +
      'their owned objects times the owner reserve (`base`, `increment`), at the snapshot ledger. `minted`, `amm` and ' +
      '`reserves` are left out where the network or the snapshot has none. A part read from the indexed history ends with ' +
      'its `coverage`: the first ledger the history is whole from, and whether it is whole back to where the feature ' +
      'starts. Before the first snapshot the answer is 404 `supply not computed yet`.',
  })
  snapshot(): Promise<SupplyAnswer> {
    return this.supply.snapshot();
  }
}
