import { Module } from '@nestjs/common';
import { CacheService } from '../common/cache.service';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';

@Module({
  controllers: [AccountsController],
  providers: [AccountsService, CacheService],
  exports: [AccountsService],
})
export class AccountsModule {}
