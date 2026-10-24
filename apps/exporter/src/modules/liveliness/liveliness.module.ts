import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { LivelinessController } from './liveliness.controller';
import { LivelinessService } from './liveliness.service';

@Module({
  imports: [TerminusModule],
  providers: [LivelinessService],
  controllers: [LivelinessController],
})
export class LivelinessModule {}
