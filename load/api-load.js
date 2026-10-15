// k6 load test for the Data API. Install k6 (https://k6.io), then:
//
//   BASE_URL=http://localhost:3001 API_KEY=test-key-123 k6 run load/api-load.js
//
// Ramps virtual users across the read endpoints and asserts latency/error thresholds.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const errors = new Rate('errors');
const BASE = __ENV.BASE_URL || 'http://localhost:3001';
const KEY = __ENV.API_KEY || '';

export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 50 }, // warm up
        { duration: '1m', target: 200 }, // sustained
        { duration: '1m', target: 500 }, // peak
        { duration: '30s', target: 0 }, // ramp down
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1500'],
    errors: ['rate<0.01'],
    http_req_failed: ['rate<0.01'],
  },
};

const params = { headers: { 'X-API-Key': KEY } };
const CURRENCIES = ['XRP', 'USD', 'EUR', 'BTC'];

const endpoints = [
  () => `${BASE}/v2/payments?limit=200`,
  () => `${BASE}/v2/payments?currency=${CURRENCIES[Math.floor(Math.random() * CURRENCIES.length)]}&limit=100`,
  () => `${BASE}/v2/transactions?limit=100`,
  () => `${BASE}/v2/ledgers?limit=100`,
  () => `${BASE}/v2/stats`,
  () => `${BASE}/v2/network/payment_volume?currency=XRP`,
  () => `${BASE}/v2/exchanges/USD+rIssuer1/XRP?interval=1hour&limit=200`,
];

export default function () {
  const url = endpoints[Math.floor(Math.random() * endpoints.length)]();
  const res = http.get(url, params);
  const ok = check(res, {
    'status 200': (r) => r.status === 200,
    'has body': (r) => r.body && r.body.length > 0,
  });
  errors.add(!ok);
  sleep(Math.random() * 0.5);
}
