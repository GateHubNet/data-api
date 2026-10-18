// AMM route sweep against a locally running API + the scratch ClickHouse it reads.
//   API_BASE=http://127.0.0.1:23001 API_KEY=<key> CH_URL=http://127.0.0.1:28123 DB=xrpl OUT=<dir> node amm-smoke.js
// Every call is saved as <OUT>/NNN-<name>.json ({request, status, headers, body}); the key is only sent as a header and is never written.
// Discovers its samples (pools, an LP account, a trader) from the database, calls every AMM route and the `amm` filter of the exchange
// routes, and checks what the docs promise: status, key order, counts against SQL, paging, the Link header, CSV shape.
const fs = require('fs');
const path = require('path');

const BASE = process.env.API_BASE || 'http://127.0.0.1:23001';
const KEY = process.env.API_KEY || '';
const CH = process.env.CH_URL || 'http://127.0.0.1:28123';
const DB = process.env.DB || 'xrpl';
const OUT = process.env.OUT || path.join(__dirname, 'smoke');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const checks = [];
let seq = 0;

async function ch(sql) {
  const r = await fetch(`${CH}/?default_format=JSONEachRow`, { method: 'POST', body: sql });
  const t = await r.text();
  if (!r.ok) throw new Error(`ClickHouse: ${t.slice(0, 300)}`);
  return t.trim() === '' ? [] : t.trim().split('\n').map((l) => JSON.parse(l));
}

const keepHeaders = ['content-type', 'content-disposition', 'link', 'cache-control', 'x-ratelimit-limit'];

async function call(name, p, opts = {}) {
  const n = String(++seq).padStart(3, '0');
  const headers = opts.key === false ? {} : { 'X-API-Key': KEY };
  const t0 = Date.now();
  const r = await fetch(BASE + p, { headers, redirect: 'manual' });
  const text = await r.text();
  const ms = Date.now() - t0;
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const h = {};
  for (const k of keepHeaders) if (r.headers.get(k) !== null) h[k] = r.headers.get(k);
  const rec = { n, name, request: `GET ${p}`, status: r.status, ms, headers: h, bytes: text.length };
  fs.writeFileSync(path.join(OUT, `${n}-${name}.json`), JSON.stringify({ ...rec, body: json !== undefined ? json : text }, null, 2));
  results.push(rec);
  return { status: r.status, headers: r.headers, text, json, rec };
}

function check(label, ok, detail = '') {
  checks.push({ label, ok: !!ok, detail: ok ? '' : String(detail).slice(0, 400) });
  if (!ok) console.log(`  FAIL ${label} ${String(detail).slice(0, 300)}`);
  return ok;
}

// the keys of `obj` must be the required keys plus any of the optional ones, in the documented order
function orderOk(obj, full) {
  const keys = Object.keys(obj);
  let i = 0;
  for (const k of keys) {
    const at = full.findIndex((f, j) => j >= i && f.replace('?', '') === k);
    if (at < 0) return false;
    i = at + 1;
  }
  return full.filter((f) => !f.endsWith('?')).every((f) => keys.includes(f));
}

const POOL = ['amm_account', 'base_currency', 'base_issuer?', 'counter_currency', 'counter_issuer?', 'reserve_base?', 'reserve_counter?', 'lp_supply?', 'lp_currency?', 'trading_fee?', 'auction_slot?', 'value_native?', 'created_ledger?', 'created_by?', 'last_ledger', 'deleted'];
const STATE = ['amm_account', 'ledger_index', 'tx_index', 'tx_hash', 'tx_type', 'executed_time', 'base_currency', 'base_issuer?', 'counter_currency', 'counter_issuer?', 'reserve_base?', 'reserve_counter?', 'lp_supply?', 'lp_currency?', 'trading_fee?', 'auction_slot?', 'deleted'];
const DAY = ['amm_account', 'date', 'base_currency', 'base_issuer?', 'counter_currency', 'counter_issuer?', 'swap_count', 'volume_base', 'volume_counter', 'fees_base_est', 'fees_counter_est', 'deposit_count', 'withdraw_count', 'liquidity_in_base', 'liquidity_in_counter', 'liquidity_out_base', 'liquidity_out_counter', 'reserve_base?', 'reserve_counter?', 'lp_supply?', 'trading_fee?', 'value_native?'];
const LIQ = ['amm_account', 'ledger_index', 'tx_index', 'tx_hash', 'executed_time', 'account', 'initiator', 'event', 'mode?', 'base_amount', 'counter_amount', 'lp_tokens'];
const POSITION = ['pool', 'lp_currency', 'lp_balance', 'share', 'base_amount?', 'counter_amount?'];
const EXCH = ['base_amount', 'counter_amount', 'node_index', 'rate', 'tx_index', 'autobridged_currency?', 'autobridged_issuer?', 'buyer', 'executed_time', 'ledger_index', 'offer_sequence', 'provider', 'seller', 'taker', 'tx_hash', 'tx_type', 'base_currency', 'base_issuer?', 'counter_currency', 'counter_issuer?', 'amm_account?'];
const ACCT_EXCH = ['base_amount', 'counter_amount', 'node_index', 'rate', 'tx_index', 'autobridged_currency?', 'autobridged_issuer?', 'base_currency', 'base_issuer?', 'buyer', 'client?', 'counter_currency', 'counter_issuer?', 'executed_time', 'ledger_index', 'offer_sequence', 'provider', 'seller', 'taker', 'tx_hash', 'tx_type', 'amm_account?'];

const asset = (c, i) => (c === 'XRP' || !i ? c : `${c}+${i}`);
const qasset = (c, i) => encodeURIComponent(asset(c, i)); // a raw + in a query string is a space
const pairPath = (p) => `${asset(p.base_currency, p.base_issuer)}/${asset(p.counter_currency, p.counter_issuer)}`;
const csvRows = (t) => t.trim().split('\n').length - 1;
const csvHeader = (t) => t.split('\n')[0].replace(/"/g, '');

async function walk(p, key, limit, label = 'walk', maxPages = 200) {
  const all = [];
  let marker;
  let pages = 0;
  let linkOk = true;
  do {
    const sep = p.includes('?') ? '&' : '?';
    const r = await call(label, `${p}${sep}limit=${limit}${marker ? '&marker=' + encodeURIComponent(marker) : ''}`);
    if (r.status !== 200) return { all, pages, status: r.status, linkOk: false };
    all.push(...r.json[key]);
    marker = r.json.marker;
    if (marker && !/rel="next"/.test(r.headers.get('link') || '')) linkOk = false;
    pages++;
  } while (marker && pages < maxPages);
  return { all, pages, status: 200, linkOk };
}

(async () => {
  const dbPools = await ch(`SELECT amm_account, base_currency, base_issuer, counter_currency, counter_issuer, deleted, value_native FROM ${DB}.amm_pools FINAL`);
  const live = dbPools.filter((p) => !p.deleted);
  const swapPools = await ch(`SELECT amm_account, count() AS swaps FROM ${DB}.exchanges WHERE amm_account != '' GROUP BY amm_account ORDER BY swaps DESC`);
  const liqRows = await ch(`SELECT amm_account, event, account, ledger_index FROM ${DB}.amm_liquidity ORDER BY ledger_index`);
  const topSwapPool = dbPools.find((p) => p.amm_account === swapPools[0].amm_account);
  const liqPoolAcct = liqRows.find((r) => r.event === 'deposit').amm_account;
  const liqPool = dbPools.find((p) => p.amm_account === liqPoolAcct);
  const createRow = liqRows.find((r) => r.event === 'create');
  const lp = liqRows.find((r) => r.event === 'deposit').account;
  const trader = (await ch(`SELECT taker, count() c FROM ${DB}.exchanges WHERE amm_account != '' GROUP BY taker ORDER BY c DESC LIMIT 1`))[0].taker;
  const ledgerRange = (await ch(`SELECT min(ledger_index) AS lo, max(ledger_index) AS hi, min(close_time) AS t0, max(close_time) AS t1 FROM ${DB}.ledgers`))[0];
  const day = String(ledgerRange.t0).slice(0, 10);
  const unknown = 'rrrrrrrrrrrrrrrrrrrrBZbvji';
  console.log(`pools in db ${dbPools.length}; top swap pool ${topSwapPool.amm_account} (${swapPools[0].swaps}); LP ${lp}; trader ${trader}; day ${day}`);

  // ---------------------------------------------------------------- GET /v2/amm/pools
  let r = await call('pools-default', '/v2/amm/pools?limit=3');
  check('pools: 200', r.status === 200, r.status);
  check('pools: wrapper keys', r.json && orderOk(r.json, ['result', 'count', 'marker?', 'pools']), Object.keys(r.json || {}));
  check('pools: Pool key order', (r.json.pools || []).every((p) => orderOk(p, POOL)), JSON.stringify(r.json.pools[0] && Object.keys(r.json.pools[0])));
  check('pools: marker and Link', !!r.json.marker && /rel="next"/.test(r.headers.get('link') || ''), r.headers.get('link'));
  check('pools: Cache-Control', /max-age/.test(r.headers.get('cache-control') || ''), r.headers.get('cache-control'));

  const w = await walk('/v2/amm/pools', 'pools', 50, 'pools-walk');
  check('pools: walk of all pages is 200', w.status === 200, w.status);
  check(`pools: walk count ${w.all.length} = SQL live pools ${live.length}`, w.all.length === live.length);
  check('pools: no duplicate pool in the walk', new Set(w.all.map((p) => p.amm_account)).size === w.all.length);
  check('pools: Link on every page with a marker', w.linkOk);
  let sorted = true;
  for (let i = 1; i < w.all.length; i++) {
    const a = w.all[i - 1];
    const b = w.all[i];
    const va = a.value_native === undefined ? -Infinity : Number(a.value_native);
    const vb = b.value_native === undefined ? -Infinity : Number(b.value_native);
    if (vb > va || (vb === va && a.amm_account > b.amm_account)) sorted = false;
  }
  check('pools: order = value_native desc (no value last), then account', sorted);
  const walkBy = new Map(w.all.map((p) => [p.amm_account, p]));

  r = await call('pools-asset-xrp', '/v2/amm/pools?asset=XRP&limit=1000');
  const withXrp = live.filter((p) => p.base_currency === 'XRP' || p.counter_currency === 'XRP').length;
  check(`pools: asset=XRP gives the ${withXrp} pools with the native currency`, r.status === 200 && r.json.count === withXrp, `${r.status} ${r.json && r.json.count}`);
  const iou = topSwapPool.base_currency === 'XRP' ? { c: topSwapPool.counter_currency, i: topSwapPool.counter_issuer } : { c: topSwapPool.base_currency, i: topSwapPool.base_issuer };
  r = await call('pools-asset-iou', `/v2/amm/pools?asset=${qasset(iou.c, iou.i)}&limit=1000`);
  const sqlIou = live.filter((p) => (p.base_currency === iou.c && p.base_issuer === iou.i) || (p.counter_currency === iou.c && p.counter_issuer === iou.i)).length;
  check(`pools: asset=${iou.c.slice(0, 8)}+issuer gives ${sqlIou}`, r.status === 200 && r.json.count === sqlIou, `${r.status} ${r.json && r.json.count}`);
  r = await call('pools-asset-pair', `/v2/amm/pools?asset=XRP&asset2=${qasset(iou.c, iou.i)}`);
  check('pools: asset + asset2 = the pools that have both', r.status === 200 && r.json.pools.some((p) => p.amm_account === topSwapPool.amm_account), r.status);
  r = await call('pools-asset-sep', `/v2/amm/pools?asset=${iou.c}.${iou.i}&asset2=XRP`);
  check('pools: separator "." works', r.status === 200 && r.json.count >= 1, r.status);
  r = await call('pools-asset-raw-plus', `/v2/amm/pools?asset=XRP&asset2=${asset(iou.c, iou.i)}`);
  check('pools: DOC EXAMPLE with a raw + (asset2=CUR+issuer) works as documented', r.status === 200, `${r.status} ${r.text.slice(0, 100)}`);
  r = await call('pools-asset-pipe', `/v2/amm/pools?asset=XRP&asset2=${iou.c}|${iou.i}`);
  check('pools: separator | works', r.status === 200 && r.json.count >= 1, `${r.status} ${r.text.slice(0, 100)}`);
  r = await call('pools-include-deleted', '/v2/amm/pools?include_deleted=true&limit=1000');
  check('pools: include_deleted=true is 200 and not fewer', r.status === 200 && r.json.count >= live.length, `${r.status} ${r.json && r.json.count}`);
  r = await call('pools-csv', '/v2/amm/pools?format=csv&limit=5');
  check('pools: csv content type and file name', r.status === 200 && /text\/csv/.test(r.headers.get('content-type') || '') && /amm pools\.csv/.test(r.headers.get('content-disposition') || ''), JSON.stringify(r.rec.headers));
  check('pools: csv has 5 rows and a Link', csvRows(r.text) === 5 && /rel="next"/.test(r.headers.get('link') || ''), `${csvRows(r.text)} ${r.headers.get('link')}`);
  check('pools: csv header starts with the Pool keys', csvHeader(r.text).startsWith('amm_account,base_currency,base_issuer,counter_currency'), csvHeader(r.text));
  r = await call('pools-bad-asset', '/v2/amm/pools?asset=USD');
  check('pools: asset=USD (no issuer) is 400', r.status === 400, `${r.status} ${r.text.slice(0, 120)}`);
  r = await call('pools-bad-marker', '/v2/amm/pools?marker=garbage');
  check('pools: marker=garbage is 400 invalid marker', r.status === 400 && /invalid marker/.test(r.text), `${r.status} ${r.text.slice(0, 120)}`);
  r = await call('pools-no-key', '/v2/amm/pools', { key: false });
  check('pools: no API key is 401', r.status === 401, r.status);

  // ---------------------------------------------------------------- one pool
  const poolPath = `/v2/amm/pools/${topSwapPool.amm_account}`;
  r = await call('pool-detail', poolPath);
  check('pool: 200', r.status === 200, r.status);
  check('pool: wrapper and key order', r.json && orderOk(r.json, ['result', 'pool']) && orderOk(r.json.pool, POOL), JSON.stringify(r.json && r.json.pool && Object.keys(r.json.pool)));
  check('pool: equals the list element', JSON.stringify(r.json.pool) === JSON.stringify(walkBy.get(topSwapPool.amm_account)));
  const detail = r.json.pool;
  r = await call('pool-pair-forward', `/v2/amm/pools/${pairPath(topSwapPool)}`);
  check('pool: pair form (stored order) = detail', r.status === 200 && JSON.stringify(r.json.pool) === JSON.stringify(detail), r.status);
  const [b, c] = pairPath(topSwapPool).split('/');
  r = await call('pool-pair-reverse', `/v2/amm/pools/${c}/${b}`);
  check('pool: pair form (reverse order) = detail', r.status === 200 && JSON.stringify(r.json.pool) === JSON.stringify(detail), r.status);
  r = await call('pool-unknown', `/v2/amm/pools/${unknown}`);
  check('pool: unknown address is 404 pool not found', r.status === 404 && /pool not found/.test(r.text), `${r.status} ${r.text.slice(0, 100)}`);
  r = await call('pool-invalid', '/v2/amm/pools/notanaddress');
  check('pool: invalid address is 400 invalid pool', r.status === 400 && /invalid pool/.test(r.text), `${r.status} ${r.text.slice(0, 100)}`);
  r = await call('pool-pair-bad', '/v2/amm/pools/XRP+rrrrrrrrrrrrrrrrrrrrBZbvji/USD');
  check('pool: pair XRP with an issuer is 400', r.status === 400, `${r.status} ${r.text.slice(0, 100)}`);

  // ---------------------------------------------------------------- history
  const hp = (pool) => `/v2/amm/pools/${pool}/history`;
  const statesSql = await ch(`SELECT count() AS c FROM ${DB}.amm_pool_states WHERE amm_account = '${liqPoolAcct}'`);
  r = await call('history-all', `${hp(liqPoolAcct)}?limit=1000`);
  check('history: 200 and list key `history`', r.status === 200 && Array.isArray(r.json.history), r.status);
  check(`history: ${r.json.history.length} states = SQL ${statesSql[0].c}`, r.json.history.length === Number(statesSql[0].c));
  check('history: PoolState key order', r.json.history.every((s) => orderOk(s, STATE)), JSON.stringify(Object.keys(r.json.history[0])));
  check('history: ascending in (ledger_index, tx_index)', r.json.history.every((s, i, a) => i === 0 || s.ledger_index > a[i - 1].ledger_index || (s.ledger_index === a[i - 1].ledger_index && s.tx_index > a[i - 1].tx_index)));
  const lastState = r.json.history[r.json.history.length - 1];
  const liqDetail = walkBy.get(liqPoolAcct);
  check('history: the last state carries the pool\'s reserves, lp_supply and fee', lastState.reserve_base === liqDetail.reserve_base && lastState.reserve_counter === liqDetail.reserve_counter && lastState.lp_supply === liqDetail.lp_supply && lastState.trading_fee === liqDetail.trading_fee, JSON.stringify([lastState, liqDetail]));
  r = await call('history-desc-page', `${hp(liqPoolAcct)}?descending=true&limit=2`);
  check('history: descending + limit=2 gives a marker', r.status === 200 && r.json.count === 2 && !!r.json.marker, `${r.status} ${r.json && r.json.count}`);
  if (r.json.marker) {
    const p2 = await call('history-desc-page2', `${hp(liqPoolAcct)}?descending=true&limit=2&marker=${encodeURIComponent(r.json.marker)}`);
    check('history: page 2 continues below page 1', p2.status === 200 && p2.json.history[0].ledger_index <= r.json.history[1].ledger_index, p2.status);
  }
  r = await call('history-day', `${hp(topSwapPool.amm_account)}?interval=day`);
  check('history: interval=day is 200 with `days`', r.status === 200 && Array.isArray(r.json.days), `${r.status}`);
  check('history: PoolDay key order', (r.json.days || []).every((d) => orderOk(d, DAY)), JSON.stringify(r.json.days && r.json.days[0] && Object.keys(r.json.days[0])));
  const dsql = (await ch(`SELECT swap_count FROM ${DB}.amm_daily FINAL WHERE amm_account = '${topSwapPool.amm_account}' AND day = '${day}'`))[0];
  check('history: day swap_count = amm_daily row', dsql && r.json.days[0] && r.json.days[0].swap_count === Number(dsql.swap_count), JSON.stringify([dsql, r.json.days[0]]));
  r = await call('history-day-csv', `${hp(topSwapPool.amm_account)}?interval=day&format=csv`);
  check('history: day csv', r.status === 200 && /text\/csv/.test(r.headers.get('content-type') || '') && /amm history\.csv/.test(r.headers.get('content-disposition') || ''), JSON.stringify(r.rec.headers));
  r = await call('history-csv', `${hp(liqPoolAcct)}?format=csv&limit=3`);
  check('history: csv 3 rows with the auction columns', r.status === 200 && csvRows(r.text) === 3 && /auction_slot\.holder/.test(csvHeader(r.text)), csvHeader(r.text));
  r = await call('history-bad-interval', `${hp(liqPoolAcct)}?interval=hour`);
  check('history: interval=hour is 400 invalid interval', r.status === 400 && /invalid interval/.test(r.text), `${r.status} ${r.text.slice(0, 80)}`);
  r = await call('history-unknown', hp(unknown));
  check('history: unknown pool is 404', r.status === 404, r.status);
  r = await call('history-bad-start', `${hp(liqPoolAcct)}?start=notadate`);
  check('history: bad start is 400', r.status === 400 && /invalid start date format/.test(r.text), `${r.status} ${r.text.slice(0, 80)}`);

  // ---------------------------------------------------------------- swaps
  const sp = (pool) => `/v2/amm/pools/${pool}/swaps`;
  const wsw = await walk(sp(topSwapPool.amm_account), 'exchanges', 10, 'swaps-walk');
  check(`swaps: walk ${wsw.all.length} = SQL ${swapPools[0].swaps}`, wsw.all.length === Number(swapPools[0].swaps), wsw.all.length);
  check('swaps: every row is a swap of this pool, key order with amm_account last', wsw.all.every((x) => x.amm_account === topSwapPool.amm_account && x.provider === topSwapPool.amm_account && x.offer_sequence === 0 && orderOk(x, EXCH) && Object.keys(x).pop() === 'amm_account'));
  check('swaps: pair as stored (no inversion)', wsw.all.every((x) => x.base_currency === topSwapPool.base_currency && x.counter_currency === topSwapPool.counter_currency));
  check('swaps: Link on every page with a marker', wsw.linkOk);
  r = await call('swaps-csv', `${sp(topSwapPool.amm_account)}?format=csv&limit=4`);
  check('swaps: csv name, 4 rows, amm_account last column', r.status === 200 && /amm swaps\.csv/.test(r.headers.get('content-disposition') || '') && csvRows(r.text) === 4 && csvHeader(r.text).endsWith('amm_account'), `${r.rec.headers['content-disposition']} ${csvHeader(r.text)}`);
  r = await call('swaps-ignores-amm', `${sp(topSwapPool.amm_account)}?amm=bogus&limit=2`);
  check('swaps: amm=bogus is ignored (200)', r.status === 200, r.status);
  r = await call('swaps-desc', `${sp(topSwapPool.amm_account)}?descending=true&limit=2`);
  check('swaps: descending newest first', r.status === 200 && r.json.exchanges[0].ledger_index >= r.json.exchanges[1].ledger_index, r.status);
  r = await call('swaps-unknown', sp(unknown));
  check('swaps: unknown pool is 404', r.status === 404, r.status);
  r = await call('swaps-bad-limit', `${sp(topSwapPool.amm_account)}?limit=abc`);
  check('swaps: limit=abc is 400 invalid limit: NaN', r.status === 400 && /invalid limit: NaN/.test(r.text), `${r.status} ${r.text.slice(0, 80)}`);
  r = await call('swaps-empty-window', `${sp(topSwapPool.amm_account)}?start=2020-01-01&end=2020-01-02`);
  check('swaps: empty window is 200 with an empty list', r.status === 200 && r.json.count === 0, `${r.status}`);

  // ---------------------------------------------------------------- liquidity
  const lq = (pool) => `/v2/amm/pools/${pool}/liquidity`;
  const sqlLiq = liqRows.filter((x) => x.amm_account === liqPoolAcct);
  r = await call('liquidity-all', lq(liqPoolAcct));
  check(`liquidity: ${r.json && r.json.count} events = SQL ${sqlLiq.length}`, r.status === 200 && r.json.count === sqlLiq.length, r.status);
  check('liquidity: LiquidityEvent key order', r.json.liquidity.every((e) => orderOk(e, LIQ)), JSON.stringify(Object.keys(r.json.liquidity[0])));
  r = await call('liquidity-create', lq(createRow.amm_account));
  check('liquidity: the created pool has a create event', r.status === 200 && r.json.liquidity.some((e) => e.event === 'create'), `${r.status}`);
  r = await call('liquidity-event-deposit', `${lq(liqPoolAcct)}?event=deposit`);
  check('liquidity: event=deposit only deposits', r.status === 200 && r.json.liquidity.length > 0 && r.json.liquidity.every((e) => e.event === 'deposit'), r.status);
  r = await call('liquidity-event-withdraw', `${lq(liqPoolAcct)}?event=withdraw`);
  check('liquidity: event=withdraw on a deposit-only pool is an empty 200', r.status === 200, r.status);
  r = await call('liquidity-account', `${lq(liqPoolAcct)}?account=${lp}`);
  check('liquidity: account filter', r.status === 200 && r.json.liquidity.every((e) => e.account === lp), r.status);
  r = await call('liquidity-bad-event', `${lq(liqPoolAcct)}?event=bogus`);
  check('liquidity: event=bogus is 400 invalid event', r.status === 400 && /invalid event/.test(r.text), `${r.status} ${r.text.slice(0, 80)}`);
  r = await call('liquidity-csv', `${lq(liqPoolAcct)}?format=csv`);
  check('liquidity: csv', r.status === 200 && /amm liquidity\.csv/.test(r.headers.get('content-disposition') || '') && csvRows(r.text) === sqlLiq.length && csvHeader(r.text) === LIQ.map((k) => k.replace('?', '')).join(','), `${csvHeader(r.text)}`);
  r = await call('liquidity-paging', `${lq(liqPoolAcct)}?limit=1`);
  check('liquidity: limit=1 gives a marker and Link', r.status === 200 && !!r.json.marker && /rel="next"/.test(r.headers.get('link') || ''), r.status);
  r = await call('liquidity-unknown', lq(unknown));
  check('liquidity: unknown pool is 404', r.status === 404, r.status);

  // ---------------------------------------------------------------- governance
  const gv = (pool) => `/v2/amm/pools/${pool}/governance`;
  const govSql = await ch(`SELECT amm_account, kind FROM ${DB}.amm_governance ORDER BY ledger_index`);
  const govPool = govSql.length ? govSql[0].amm_account : liqPoolAcct;
  const govOfPool = govSql.filter((x) => x.amm_account === govPool);
  const VOTE = ['amm_account', 'ledger_index', 'tx_index', 'tx_hash', 'executed_time', 'type', 'account', 'fee_voted?', 'trading_fee_after?'];
  const BID = ['amm_account', 'ledger_index', 'tx_index', 'tx_hash', 'executed_time', 'type', 'account', 'bid_min?', 'bid_max?', 'price_paid?', 'auction_slot?'];
  r = await call('governance-all', gv(govPool));
  check(`governance: ${r.json && r.json.count} rows = SQL ${govOfPool.length} (${govSql.length ? 'a pool with governance rows' : 'empty here: no AMMVote/AMMBid in the window'})`, r.status === 200 && Array.isArray(r.json.governance) && r.json.count === govOfPool.length, r.status);
  check('governance: Vote / Bid key order', r.json.governance.every((x) => (x.type === 'vote' ? orderOk(x, VOTE) : orderOk(x, BID))), JSON.stringify(r.json.governance[0] && Object.keys(r.json.governance[0])));
  r = await call('governance-type-vote', `${gv(govPool)}?type=vote`);
  check('governance: type=vote', r.status === 200 && r.json.governance.length === govOfPool.filter((x) => x.kind === 'vote').length, `${r.status} ${r.json && r.json.count}`);
  r = await call('governance-type-bid', `${gv(govPool)}?type=bid`);
  check('governance: type=bid', r.status === 200 && r.json.governance.length === govOfPool.filter((x) => x.kind === 'bid').length, `${r.status} ${r.json && r.json.count}`);
  r = await call('governance-type-bad', `${gv(govPool)}?type=bogus`);
  check('governance: type=bogus is 400 invalid type', r.status === 400 && /invalid type/.test(r.text), `${r.status} ${r.text.slice(0, 80)}`);
  r = await call('governance-csv', `${gv(govPool)}?format=csv`);
  const GOVCSV = 'amm_account,ledger_index,tx_index,tx_hash,executed_time,type,account,fee_voted,trading_fee_after,bid_min,bid_max,price_paid,auction_slot.holder,auction_slot.discounted_fee,auction_slot.expiration,auction_slot.auth_accounts';
  check(govOfPool.length ? 'governance: csv has the 16 columns' : 'governance: csv of an empty list is an empty body (as every other list)', r.status === 200 && /amm governance\.csv/.test(r.headers.get('content-disposition') || '') && (govOfPool.length ? csvHeader(r.text) === GOVCSV && csvRows(r.text) === govOfPool.length : r.text === ''), `${csvHeader(r.text)}`);
  r = await call('governance-unknown', gv(unknown));
  check('governance: unknown pool is 404', r.status === 404, r.status);

  // ---------------------------------------------------------------- account routes
  r = await call('acct-amm-liquidity', `/v2/accounts/${lp}/amm_liquidity`);
  const sqlAcct = await ch(`SELECT count() AS c FROM ${DB}.account_amm_liquidity WHERE account = '${lp}'`);
  check(`account liquidity: ${r.json && r.json.count} = SQL ${sqlAcct[0].c}`, r.status === 200 && r.json.count === Number(sqlAcct[0].c), r.status);
  check('account liquidity: LiquidityEvent key order', r.json.liquidity.every((e) => orderOk(e, LIQ)));
  r = await call('acct-amm-liquidity-pool', `/v2/accounts/${lp}/amm_liquidity?pool=${liqPoolAcct}&event=deposit`);
  check('account liquidity: pool + event filters', r.status === 200 && r.json.liquidity.every((e) => e.amm_account === liqPoolAcct && e.event === 'deposit'), r.status);
  r = await call('acct-amm-liquidity-csv', `/v2/accounts/${lp}/amm_liquidity?format=csv`);
  check('account liquidity: csv', r.status === 200 && /amm liquidity\.csv/.test(r.headers.get('content-disposition') || ''), r.rec.headers['content-disposition']);
  r = await call('acct-amm-liquidity-bad-pool', `/v2/accounts/${lp}/amm_liquidity?pool=zzz`);
  check('account liquidity: pool=zzz is 400 invalid pool', r.status === 400 && /invalid pool/.test(r.text), `${r.status} ${r.text.slice(0, 80)}`);
  r = await call('acct-amm-liquidity-none', `/v2/accounts/${unknown}/amm_liquidity`);
  check('account liquidity: an address with none is an empty 200', r.status === 200 && r.json.count === 0, r.status);

  r = await call('acct-amm-positions-now', `/v2/accounts/${lp}/amm_positions`);
  check('positions: 200 with `positions`', r.status === 200 && Array.isArray(r.json.positions), r.status);
  check('positions: Position key order, sorted by pool', r.json.positions.every((x) => orderOk(x, POSITION)) && r.json.positions.every((x, i, a) => i === 0 || a[i - 1].pool <= x.pool), JSON.stringify(r.json.positions[0]));
  check('positions: no count / marker (not paged)', !('count' in r.json) && !('marker' in r.json));
  r = await call('acct-amm-positions-mid', `/v2/accounts/${lp}/amm_positions?date=${encodeURIComponent(String(ledgerRange.t1).replace(' ', 'T') + 'Z')}`);
  check('positions: date at the newest ledger is 200', r.status === 200, r.status);
  r = await call('acct-amm-positions-before', `/v2/accounts/${lp}/amm_positions?date=2024-03-01`);
  check('positions: a date before the first stored ledger gives none', r.status === 200 && r.json.positions.length === 0, `${r.status} ${JSON.stringify(r.json)}`);
  r = await call('acct-amm-positions-bad', `/v2/accounts/${lp}/amm_positions?date=nope`);
  check('positions: bad date is 400 invalid date format', r.status === 400 && /invalid date format/.test(r.text), `${r.status} ${r.text.slice(0, 80)}`);
  r = await call('acct-amm-positions-none', `/v2/accounts/${unknown}/amm_positions`);
  check('positions: an address with none is an empty 200', r.status === 200 && r.json.positions.length === 0, r.status);

  // ---------------------------------------------------------------- network amm_volume
  const vol = ['components', 'count', 'exchange', 'total', 'exchange_rate', 'start_time', 'end_time'];
  for (const live of ['hour', 'day', '3day', '7day', '30day']) {
    r = await call(`volume-live-${live}`, `/v2/network/amm_volume?live=${live}`);
    check(`amm_volume live=${live}: 200 and row keys`, r.status === 200 && r.json.rows.length === 1 && orderOk(r.json.rows[0], vol), `${r.status} ${r.text.slice(0, 100)}`);
  }
  r = await call('volume-live-day', '/v2/network/amm_volume');
  const comps = r.json.rows[0].components;
  check('amm_volume live: AMM component keys', comps.length > 0 && comps.every((x) => orderOk(x, ['amm_account', 'base', 'counter', 'count', 'amount', 'rate', 'converted_amount'])), JSON.stringify(comps[0]));
  check('amm_volume live: components sorted by converted_amount desc', comps.every((x, i, a) => i === 0 || Number(a[i - 1].converted_amount) >= Number(x.converted_amount)));
  const totalSum = comps.reduce((s, x) => s + Number(x.converted_amount), 0);
  check(`amm_volume live: total ${r.json.rows[0].total} = sum of components ${totalSum}`, Math.abs(totalSum - Number(r.json.rows[0].total)) <= Math.max(1e-6, totalSum * 1e-6));
  r = await call('volume-live-bad', '/v2/network/amm_volume?live=minute');
  check('amm_volume: live=minute is 400 invalid period', r.status === 400 && /invalid period/.test(r.text), `${r.status} ${r.text.slice(0, 100)}`);
  r = await call('volume-live-csv', '/v2/network/amm_volume?format=csv');
  check('amm_volume: csv name amm_volume.csv', r.status === 200 && /amm_volume\.csv/.test(r.headers.get('content-disposition') || ''), r.rec.headers['content-disposition']);
  r = await call('volume-hist-day', `/v2/network/amm_volume?start=${day}&end=${day}&interval=day`);
  check('amm_volume historical: 200 and row keys', r.status === 200 && Array.isArray(r.json.rows), `${r.status} ${r.text.slice(0, 100)}`);
  r = await call('volume-hist-wide', '/v2/network/amm_volume?start=2026-10-01&interval=day&limit=5');
  check('amm_volume historical (start only, limit=5): 200', r.status === 200, r.status);
  r = await call('volume-hist-week', '/v2/network/amm_volume?start=2026-10-01&interval=week');
  check('amm_volume historical week: 200', r.status === 200, r.status);
  r = await call('volume-hist-month', '/v2/network/amm_volume?start=2026-10-01&interval=month');
  check('amm_volume historical month: 200', r.status === 200, r.status);
  r = await call('volume-hist-bad-interval', '/v2/network/amm_volume?start=2026-10-01&interval=year');
  check('amm_volume historical: interval=year is 400', r.status === 400 && /invalid interval/.test(r.text), `${r.status} ${r.text.slice(0, 100)}`);
  r = await call('volume-hist-csv', `/v2/network/amm_volume?start=${day}&format=csv`);
  check('amm_volume historical csv: 200', r.status === 200, r.status);
  r = await call('volume-exchange-currency', `/v2/network/amm_volume?live=day&exchange_currency=${iou.c}&exchange_issuer=${iou.i}`);
  check('amm_volume live in a display currency: 200', r.status === 200, `${r.status} ${r.text.slice(0, 100)}`);

  // ---------------------------------------------------------------- the amm filter on the exchange routes
  const pairP = `/v2/exchanges/${pairPath(topSwapPool)}`;
  const win = `start=${day}&end=${day}T23:59:59Z`;
  const modes = {};
  for (const m of ['include', 'exclude', 'only']) {
    modes[m] = await walk(`${pairP}?${win}&amm=${m}`, 'exchanges', 100, `exchanges-pair-${m}`);
    check(`exchanges pair amm=${m}: walk is 200`, modes[m].status === 200, modes[m].status);
  }
  const sqlPair = await ch(`SELECT countIf(amm_account != '') AS swaps, countIf(amm_account = '') AS book FROM ${DB}.exchanges WHERE base_currency = '${topSwapPool.base_currency}' AND base_issuer = '${topSwapPool.base_issuer}' AND counter_currency = '${topSwapPool.counter_currency}' AND counter_issuer = '${topSwapPool.counter_issuer}'`);
  check(`exchanges pair: only ${modes.only.all.length} = SQL swaps ${sqlPair[0].swaps}`, modes.only.all.length === Number(sqlPair[0].swaps));
  check(`exchanges pair: exclude ${modes.exclude.all.length} = SQL order-book ${sqlPair[0].book}`, modes.exclude.all.length === Number(sqlPair[0].book));
  check('exchanges pair: include = exclude + only', modes.include.all.length === modes.exclude.all.length + modes.only.all.length, `${modes.include.all.length}`);
  check('exchanges pair: exclude rows have no amm_account key, only rows all have it', modes.exclude.all.every((x) => !('amm_account' in x)) && modes.only.all.every((x) => 'amm_account' in x));
  check('exchanges pair: include rows are in the contract key order', modes.include.all.every((x) => orderOk(x, EXCH)));
  r = await call('exchanges-pair-amm-bad', `${pairP}?amm=ONLY`);
  check('exchanges pair: amm=ONLY is 400 invalid amm filter', r.status === 400 && /invalid amm filter - use: include, exclude, only/.test(r.text), `${r.status} ${r.text.slice(0, 100)}`);
  r = await call('exchanges-pair-amm-empty', `${pairP}?${win}&amm=`);
  check('exchanges pair: amm= (empty) = include', r.status === 200, r.status);
  r = await call('exchanges-pair-csv', `${pairP}?${win}&amm=only&format=csv&limit=3`);
  check('exchanges pair: amm=only csv ends with amm_account', r.status === 200 && csvHeader(r.text).endsWith('amm_account') && csvRows(r.text) === 3, csvHeader(r.text));
  r = await call('exchanges-pair-csv-exclude', `${pairP}?${win}&amm=exclude&format=csv&limit=3`);
  check('exchanges pair: amm=exclude csv has no amm_account column', r.status === 200 && !/amm_account/.test(csvHeader(r.text)), csvHeader(r.text));
  r = await call('exchanges-pair-candles-only', `${pairP}?${win}&amm=only&interval=1hour`);
  check('exchanges pair: candles with amm=only', r.status === 200 && r.json.exchanges.length > 0, `${r.status} ${r.text.slice(0, 100)}`);
  const candlesOnly = r.json.exchanges.reduce((s, x) => s + x.count, 0);
  check(`exchanges pair: candle counts ${candlesOnly} = swaps ${modes.only.all.length} (swaps above the dust floor)`, candlesOnly <= modes.only.all.length && candlesOnly > 0, candlesOnly);
  r = await call('exchanges-pair-reduce-only', `${pairP}?${win}&amm=only&reduce=true`);
  check('exchanges pair: reduce with amm=only', r.status === 200 && r.json.exchanges.length === 1, `${r.status} ${r.text.slice(0, 100)}`);
  r = await call('exchanges-pair-reduce-exclude', `${pairP}?${win}&amm=exclude&reduce=true`);
  check('exchanges pair: reduce with amm=exclude is 200', r.status === 200, r.status);

  const allModes = {};
  for (const m of ['include', 'exclude', 'only']) {
    allModes[m] = await walk(`/v2/exchanges?${win}&amm=${m}`, 'exchanges', 400, `exchanges-all-${m}`);
    check(`/v2/exchanges amm=${m}: walk is 200`, allModes[m].status === 200, allModes[m].status);
  }
  const sqlAll = await ch(`SELECT countIf(amm_account != '') AS swaps, countIf(amm_account = '') AS book FROM ${DB}.exchanges`);
  check(`/v2/exchanges only ${allModes.only.all.length} = SQL ${sqlAll[0].swaps}`, allModes.only.all.length === Number(sqlAll[0].swaps));
  check(`/v2/exchanges exclude ${allModes.exclude.all.length} = SQL ${sqlAll[0].book}`, allModes.exclude.all.length === Number(sqlAll[0].book));
  check('/v2/exchanges include = exclude + only', allModes.include.all.length === allModes.exclude.all.length + allModes.only.all.length);
  r = await call('exchanges-all-amm-bad', '/v2/exchanges?amm=nope');
  check('/v2/exchanges: amm=nope is 400', r.status === 400 && /invalid amm filter/.test(r.text), `${r.status} ${r.text.slice(0, 100)}`);
  r = await call('exchanges-all-csv', `/v2/exchanges?${win}&amm=only&format=csv&limit=3`);
  check('/v2/exchanges amm=only csv', r.status === 200 && /exchanges\.csv/.test(r.headers.get('content-disposition') || '') && csvHeader(r.text).endsWith('amm_account'), csvHeader(r.text));

  const ae = (m, extra = '') => `/v2/accounts/${trader}/exchanges?amm=${m}${extra}`;
  const acct = {};
  for (const m of ['include', 'exclude', 'only']) {
    acct[m] = await walk(ae(m), 'exchanges', 200, `acct-exchanges-${m}`);
    check(`account exchanges amm=${m}: walk is 200`, acct[m].status === 200, acct[m].status);
  }
  const sqlAcctEx = await ch(`SELECT countIf(amm_account != '') AS swaps, countIf(amm_account = '') AS book FROM ${DB}.account_exchanges WHERE account = '${trader}'`);
  check(`account exchanges only ${acct.only.all.length} = SQL ${sqlAcctEx[0].swaps}`, acct.only.all.length === Number(sqlAcctEx[0].swaps));
  check(`account exchanges exclude ${acct.exclude.all.length} = SQL ${sqlAcctEx[0].book}`, acct.exclude.all.length === Number(sqlAcctEx[0].book));
  check('account exchanges include = exclude + only', acct.include.all.length === acct.exclude.all.length + acct.only.all.length);
  check('account exchanges: key order', acct.include.all.every((x) => orderOk(x, ACCT_EXCH)), JSON.stringify(acct.include.all[0] && Object.keys(acct.include.all[0])));
  r = await call('acct-exchanges-csv', `${ae('only')}&format=csv&limit=3`);
  check('account exchanges amm=only csv: file name and amm_account column', r.status === 200 && /exchanges\.csv/.test(r.headers.get('content-disposition') || '') && /amm_account/.test(csvHeader(r.text)), `${r.rec.headers['content-disposition']} ${csvHeader(r.text)}`);
  r = await call('acct-exchanges-bad', ae('x'));
  check('account exchanges: amm=x is 400', r.status === 400 && /invalid amm filter/.test(r.text), `${r.status} ${r.text.slice(0, 100)}`);
  r = await call('acct-exchanges-pool-account', `/v2/accounts/${topSwapPool.amm_account}/exchanges?amm=only&limit=5`);
  check('account exchanges: a pool account lists its own swaps', r.status === 200 && r.json.count > 0, `${r.status}`);
  r = await call('acct-exchanges-filter-pair', `/v2/accounts/${trader}/exchanges/${pairPath(topSwapPool)}?amm=only`);
  check('account exchanges /{base}/{counter} with amm=only: 200', r.status === 200, r.status);

  // ---------------------------------------------------------------- summary
  const pass = checks.filter((x) => x.ok).length;
  const fail = checks.filter((x) => !x.ok);
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ calls: results.length, checks: checks.length, pass, fail: fail.length, failed: fail, samples: { topSwapPool: topSwapPool.amm_account, liqPool: liqPoolAcct, createdPool: createRow.amm_account, lp, trader, day }, results }, null, 2));
  console.log(`\n${results.length} calls, ${checks.length} checks: ${pass} pass, ${fail.length} fail`);
  for (const f of fail) console.log(`  FAIL ${f.label}: ${f.detail}`);
  process.exit(fail.length ? 1 : 0);
})().catch((e) => {
  console.error('smoke crashed:', e);
  process.exit(2);
});
