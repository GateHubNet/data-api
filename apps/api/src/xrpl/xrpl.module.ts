import { Global, Module } from '@nestjs/common';
import { XrplService } from './xrpl.service';

@Global()
@Module({
  providers: [XrplService],
  exports: [XrplService],
})
export class XrplModule {}
