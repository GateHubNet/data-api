import { ClickHouseService, runMigrations, Table } from '@gatehub/data-api-shared';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';

const API_KEY = 'test-key-123';

describe('Data API (e2e)', () => {
  let ch: StartedClickHouse;
  let app: INestApplication;
  let chService: ClickHouseService;

  beforeAll(async () => {
    ch = await startClickHouse();
    process.env.GH_API_KEYS = API_KEY;
    process.env.GH_RATE_LIMIT = '100000';

    await runMigrations();

    // Seed a couple of payments so list/stats endpoints return data.
    const { ClickHouseService: CHS } = await import('@gatehub/data-api-shared');
    chService = new CHS({
      url: ch.url,
      username: 'default',
      password: '',
      database: ch.database,
      requestTimeout: 30000,
      maxOpenConnections: 5,
      maxExecutionTime: 30,
      maxQueryMemoryBytes: 0,
    });
    await chService.insert(Table.Payments, [
      { ctid: 'C0000001000A0000', tx_hash: 'H1', source: 'rA', destination: 'rB', currency: 'USD', amount: 100, delivered_amount: 100, fee: 0.1, date: '2024-06-01 12:00:00', ledger_index: 1000, tx_index: 1 },
      { ctid: 'C0000002000B0000', tx_hash: 'H2', source: 'rC', destination: 'rA', currency: 'XRP', amount: 50, delivered_amount: 50, fee: 0.1, date: '2024-06-02 09:00:00', ledger_index: 1001, tx_index: 1 },
    ]);

    // Import AppModule AFTER env is set (config is read at module-init time).
    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: true } }));
    app.enableVersioning({ type: VersioningType.URI });
    const { ProblemDetailsFilter } = await import('../src/common/problem-details.filter');
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await chService?.onModuleDestroy();
    await ch?.container.stop();
  });

  it('rejects requests without an API key (401, problem+json)', async () => {
    const res = await request(app.getHttpServer()).get('/v2/payments');
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 401, title: expect.any(String), type: expect.any(String) });
  });

  it('allows operational paths without a key', async () => {
    const res = await request(app.getHttpServer()).get('/liveliness/healthz');
    expect([200, 503]).toContain(res.status); // up or down, but not 401
  });

  it('returns payments with a valid X-API-Key', async () => {
    const res = await request(app.getHttpServer()).get('/v2/payments?limit=10').set('X-API-Key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('success');
    expect(res.body.count).toBe(2);
    expect(res.body.payments).toHaveLength(2);
  });

  it('accepts the key via Authorization: Bearer too', async () => {
    const res = await request(app.getHttpServer()).get('/v2/payments?currency=USD').set('Authorization', `Bearer ${API_KEY}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });

  it('validates query params and returns problem+json on 400', async () => {
    const res = await request(app.getHttpServer()).get('/v2/payments?limit=99999').set('X-API-Key', API_KEY);
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(Array.isArray(res.body.errors)).toBe(true);
  });

  it('returns problem+json 404 for an unknown transaction hash', async () => {
    const res = await request(app.getHttpServer()).get('/v2/transactions/DEADBEEF').set('X-API-Key', API_KEY);
    expect(res.status).toBe(404);
    expect(res.body.status).toBe(404);
  });

  it('serves daily stats from the materialized view', async () => {
    const res = await request(app.getHttpServer()).get('/v2/stats').set('X-API-Key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.stats.length).toBeGreaterThanOrEqual(1);
  });

  it('records HTTP metrics on /metricz (MetricsInterceptor wired)', async () => {
    // make a request, then confirm the counter reflects it
    await request(app.getHttpServer()).get('/v2/payments?limit=5').set('X-API-Key', API_KEY);
    const res = await request(app.getHttpServer()).get('/metricz');
    expect(res.status).toBe(200);
    expect(res.text).toContain('api_http_requests_total');
    expect(res.text).toContain('api_http_request_duration_seconds');
    // a request to /v2/payments must have been counted with a 2xx status
    expect(res.text).toMatch(/api_http_requests_total\{[^}]*status="200"[^}]*\}\s+[1-9]/);
  });
});
