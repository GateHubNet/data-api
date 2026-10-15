import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

/** Builds the OpenAPI document for the Data API (shared by the live server and the generator). */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('GateHub XRPL Data API')
    .setDescription('Historical XRP Ledger data — payments, exchanges, ledgers, accounts and network analytics, served from ClickHouse.')
    .setVersion('2.0.0')
    .addServer('http://localhost:3001', 'Local')
    .addServer('https://api.gatehub.net/data-api', 'Production')
    .addApiKey({ type: 'apiKey', in: 'header', name: 'X-API-Key' }, 'api-key')
    .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'bearer')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  // Apply the API-key / bearer requirement to every operation by default.
  document.security = [{ 'api-key': [] }, { bearer: [] }];
  return document;
}
