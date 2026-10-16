import { Module } from '@nestjs/common';
import { ActiveAccountsController } from './active-accounts.controller';
import { ActiveAccountsService } from './active-accounts.service';

/** `GET /v2/active_accounts/:base/:counter`. */
@Module({
  controllers: [ActiveAccountsController],
  providers: [ActiveAccountsService],
})
export class ActiveAccountsModule {}
