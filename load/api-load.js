// k6 load test for the Data API (Ripple Data API v2 compatible). Install k6 (https://k6.io), seed a throwaway database with
// load/seed.js, start the API against it, then:
//
//   BASE_URL=http://localhost:3001 API_KEY=test-key-123 \
//   ACCOUNT=<account printed by the seeder> FIRST_LEDGER=90000000 LEDGERS=20000 k6 run load/api-load.js
//
// Ramps virtual users across the read endpoints (all of them exist in apps/api) and asserts latency/error thresholds. The paths
// need the synthetic data of load/seed.js (USD/EUR of rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq, BTC of rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B,
// the native currency). Raise GH_RATE_LIMIT of the API for the run: one client address makes all the requests.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const errors = new Rate('errors');
const BASE = __ENV.BASE_URL || 'http://localhost:3001';
const KEY = __ENV.API_KEY || '';
const ACCOUNT = __ENV.ACCOUNT || 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq';
const FIRST_LEDGER = Number(__ENV.FIRST_LEDGER || 90000000);
const LEDGERS = Number(__ENV.LEDGERS || 20000);

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
const ISSUER_A = 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq';
const ISSUER_B = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
// the currency path segments of /v2/payments/{currency}: the native currency has no issuer
const CURRENCIES = ['XRP', `USD+${ISSUER_A}`, `EUR+${ISSUER_A}`, `BTC+${ISSUER_B}`];
const pick = (list) => list[Math.floor(Math.random() * list.length)];

const endpoints = [
  () => `${BASE}/v2/payments?limit=200`,
  () => `${BASE}/v2/payments/${pick(CURRENCIES)}?limit=100`,
  () => `${BASE}/v2/transactions?limit=100`,
  () => `${BASE}/v2/transactions?type=Payment&limit=100&descending=true`,
  () => `${BASE}/v2/ledgers`,
  () => `${BASE}/v2/ledgers/${FIRST_LEDGER + Math.floor(Math.random() * LEDGERS)}?transactions=true`,
  () => `${BASE}/v2/stats?interval=hour`,
  () => `${BASE}/v2/network/fees?interval=hour`,
  () => `${BASE}/v2/network/exchange_volume`,
  () => `${BASE}/v2/network/payment_volume`,
  () => `${BASE}/v2/exchanges/USD+${ISSUER_A}/XRP?interval=1hour&limit=200`,
  () => `${BASE}/v2/exchange_rates/USD+${ISSUER_A}/XRP`,
  () => `${BASE}/v2/active_accounts/USD+${ISSUER_A}/XRP`,
  () => `${BASE}/v2/accounts/${ACCOUNT}/payments?limit=100`,
  () => `${BASE}/v2/accounts/${ACCOUNT}/transactions?limit=50`,
  () => `${BASE}/v2/accounts/${ACCOUNT}/balance_changes?limit=100`,
];

export default function () {
  const url = pick(endpoints)();
  const res = http.get(url, params);
  const ok = check(res, {
    'status 200': (r) => r.status === 200,
    'has body': (r) => r.body && r.body.length > 0,
  });
  errors.add(!ok);
  sleep(Math.random() * 0.5);
}
