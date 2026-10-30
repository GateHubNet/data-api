import { Module } from '@nestjs/common';
import { NetworkModule } from '../network/network.module';
import { TokenHoldersService } from './token-holders.service';
import { TOKEN_LIST_SERVICES, TokenKind, TokenListService } from './token-list';
import { TokenMarkets } from './token-markets';
import { TokensController } from './tokens.controller';
import { TokensService } from './tokens.service';

/**
 * The issued tokens (D6, spec 5): `GET /v2/tokens`, one token (`/{currency}.{issuer}`) and its holders. The list is served by the
 * `TokenListService` of a kind, registered in the `TOKEN_LIST_SERVICES` map (D9 adds `mpt` there); the controller reads it through
 * the map. `TokenMarkets` reads the newest `include` sets of the markets through the `MarketsService` that `NetworkModule` exports;
 * `FeatureCoverageService` and `CacheService` are global.
 */
@Module({
  imports: [NetworkModule],
  controllers: [TokensController],
  providers: [
    TokensService,
    TokenMarkets,
    TokenHoldersService,
    {
      provide: TOKEN_LIST_SERVICES,
      useFactory: (issued: TokensService): ReadonlyMap<TokenKind, TokenListService> =>
        new Map<TokenKind, TokenListService>([['issued', issued]]),
      inject: [TokensService],
    },
  ],
})
export class TokensModule {}
