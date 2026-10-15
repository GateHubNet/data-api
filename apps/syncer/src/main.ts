import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

const log = new Logger('SyncerBootstrap');

async function bootstrap(): Promise<void> {
  // The syncer is a worker, but it still runs an HTTP server so orchestrators can
  // probe /liveliness/healthz and scrape /metricz. The actual ingestion is kicked
  // off in AppService.onApplicationBootstrap.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false });
  app.disable('x-powered-by');
  app.enableShutdownHooks();

  const port = process.env.GH_HTTP_API_PORT ?? 3002;
  await app.listen(port);
  log.log(`syncer HTTP (health/metrics) listening on ${port}`);
}

bootstrap().catch((err) => {
  log.error('Fatal bootstrap error', err);
  process.exit(1);
});
