import { Global, Module } from '@nestjs/common';
import { XrplService } from './xrpl.service';

/**
 * The live-node connection. Global, like the `CommonModule` whose configuration, network profile and shutdown hook it
 * uses, so that every endpoint module and the `BinaryCodecService` can ask the node.
 */
@Global()
@Module({
  providers: [XrplService],
  exports: [XrplService],
})
export class XrplModule {}
