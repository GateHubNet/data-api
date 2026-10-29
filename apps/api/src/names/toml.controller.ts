import { isProperlyFormedTomlDomain, NetworkProfile } from '@gatehub/data-api-shared';
import { Get, Inject, Param } from '@nestjs/common';
import { ApiOperation, ApiParam } from '@nestjs/swagger';
import { badRequest, notFound } from '../common/errors';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { NETWORK_PROFILE } from '../config/api.config';
import { DomainTomlsService } from './domain-tomls.service';
import { tomlObject } from './toml-object';

/** The body of `GET /v2/toml/{domain}`. */
export interface TomlBody {
  result: 'success';
  toml: Record<string, unknown>;
}

/**
 * `GET /v2/toml/{domain}` (spec 6, GateHub extra): what the store says of one domain's toml, for "How we know" on the account
 * page. The api never fetches: the row is the newest one the tomls worker stored, read by key and kept 60 s
 * (`DomainTomlsService.get`). The default `Cache-Control` (`private, max-age=60`) is the app's; errors are `no-store`.
 */
@RippleController('v2/toml')
export class TomlController {
  constructor(
    private readonly tomls: DomainTomlsService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  @Get(':domain')
  @RippleRoute('unable to retrieve toml')
  @ApiOperation({
    summary: 'Get what the toml of a domain says',
    description:
      "What the toml file of a domain says, as the last check of it stored: the accounts it lists, the currencies, the principals' " +
      'names and the validators, only the entries that count on this network (no network, or a name of it). `status` is `ok` ' +
      '(the file was read) or `failed`, with the `reason` and, for `http_status`, the `status_code`; a toml that failed transiently ' +
      'still carries what its last read said until 24 hours after the re-read it missed, one after a definite failure carries nothing ' +
      'but the check. `checked` is when the domain was last checked, `fetched` when the content was read. Emails and social handles ' +
      'are never served. A key without a value is left out. 404 when the domain was never checked (no account named it while the ' +
      'worker ran, or its first check has not run yet); a domain no account names any more answers its last check.',
  })
  @ApiParam({
    name: 'domain',
    description: 'A domain as an account names it (`northpeak.example`); the case does not matter.',
  })
  async get(@Param('domain') raw: string): Promise<TomlBody> {
    const domain = raw.toLowerCase();
    if (!isProperlyFormedTomlDomain(domain)) throw badRequest('invalid domain');
    const row = await this.tomls.get(domain);
    if (row === undefined) throw notFound('toml not found');
    return { result: 'success', toml: tomlObject(row, this.profile) };
  }
}
