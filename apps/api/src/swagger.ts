/**
 * Generates the OpenAPI document to dist/swagger.json without serving the app.
 * Run with: pnpm --filter @gatehub/data-api-service swagger
 */
import { VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from './app.module';
import { buildOpenApiDocument } from './swagger-document';

async function generate(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableVersioning({ type: VersioningType.URI });
  const document = buildOpenApiDocument(app);
  const dir = join(process.cwd(), 'dist');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, 'swagger.json');
  writeFileSync(out, JSON.stringify(document, null, 2), 'utf8');
  // eslint-disable-next-line no-console
  console.log(`OpenAPI written to ${out}`);
  await app.close();
}

generate().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
