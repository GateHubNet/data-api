import 'dotenv/config';
import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { ProblemDetailsFilter } from './common/problem-details.filter';
import { apiConfigFromEnv } from './config/api.config';
import { buildOpenApiDocument } from './swagger-document';

const log = new Logger('ApiBootstrap');

async function bootstrap(): Promise<void> {
  const config = apiConfigFromEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.disable('x-powered-by');
  app.enableShutdownHooks();

  // The service always runs behind the GateHub reverse proxy (TLS termination + edge
  // routing happen there). Trust the proxy so `req.ip` resolves to the real client IP
  // from X-Forwarded-For — required for correct per-client rate limiting and logging.
  // `trustProxyHops` controls how many hops to trust (default 1 = the GateHub proxy).
  app.set('trust proxy', config.trustProxyHops);

  if (config.corsOrigins.length) {
    app.enableCors({ origin: config.corsOrigins });
  }

  app.useGlobalFilters(new ProblemDetailsFilter());

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: true },
      validationError: { target: false },
    }),
  );

  app.enableVersioning({ type: VersioningType.URI });

  const document = buildOpenApiDocument(app);
  SwaggerModule.setup('internal/docs', app, document, { jsonDocumentUrl: 'internal/docs/json' });

  await app.listen(config.port);
  log.log(`Data API listening on ${config.port} (docs: /internal/docs)`);
}

bootstrap().catch((err) => {
  log.error('Fatal bootstrap error', err);
  process.exit(1);
});
