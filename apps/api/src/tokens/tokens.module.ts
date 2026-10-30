import { Module } from '@nestjs/common';
import { NetworkModule } from '../network/network.module';
import { PaymentsModule } from '../payments/payments.module';
import { TokenHoldersService } from './token-holders.service';
import { TOKEN_LIST_SERVICES, TokenKind, TokenListService } from './token-list';
import { TokenMarkets } from './token-markets';
import { TokenTransfersService } from './token-transfers.service';
import { TokensController } from './tokens.controller';
import { TokensService } from './tokens.service';

/**
 * The issued tokens (D6, spec 5): `GET /v2/tokens`, one token (`/{currency}.{issuer}`), its holders and its transfers. The list is served by the
 * `TokenListService` of a kind, registered in the `TOKEN_LIST_SERVICES` map (D9 adds `mpt` there); the controller reads it through
 * the map. `TokenMarkets` reads the newest `include` sets of the markets through the `MarketsService` that `NetworkModule` exports; the
 * transfers are read through the `PaymentsService` that `PaymentsModule` exports; `FeatureCoverageService` and `CacheService` are global.
 */
@Module({
  imports: [NetworkModule, PaymentsModule],
  controllers: [TokensController],
  providers: [
    TokensService,
    TokenMarkets,
    TokenHoldersService,
    TokenTransfersService,
    {
      provide: TOKEN_LIST_SERVICES,
      useFactory: (issued: TokensService): ReadonlyMap<TokenKind, TokenListService> =>
        new Map<TokenKind, TokenListService>([['issued', issued]]),
      inject: [TokensService],
    },
  ],
})
export class TokensModule {}
