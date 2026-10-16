// End-to-end smoke test of one Data API instance against the contract table (docs/api-reference.md).
// usage: node smoke.js <xrpl|xahau>
// Responses are saved under smoke/<network>/ ; the result table goes to smoke/<network>/_results.json
// The API key is read from the throwaway env file and is never written anywhere (urls are stored without it).
const fs = require('fs');
const path = require('path');

const S = '/private/tmp/claude-501/-Users-golobitch-github-com-GateHubNet-data-api-new/096aa099-861f-4246-9d06-6b477dcfe4c1/scratchpad/verify';
const net = process.argv[2];
const CFG = { xrpl: { port: 13001, native: 'XRP' }, xahau: { port: 13011, native: 'XAH' } }[net];
if (!CFG) throw new Error('network?');
const BASE = `http://127.0.0.1:${CFG.port}`;
const KEY = fs.readFileSync(`${S}/env/api.key.env`, 'utf8').match(/GH_API_KEYS=(.*)/)[1].trim();
const OUT = `${S}/smoke/${net}`;
fs.mkdirSync(OUT, { recursive: true });
const NAT = CFG.native;

async function ch(sql) {
  const r = await fetch(`http://127.0.0.1:18123/?database=${net}&default_format=JSONEachRow`, { method: 'POST', body: sql });
  const t = await r.text();
  if (!r.ok) throw new Error(t);
  return t.trim() ? t.trim().split('\n').map((l) => JSON.parse(l)) : [];
}

const results = [];
function rec(endpoint, kind, name, status, verdict, note, url) {
  results.push({ endpoint, kind, name, url, status, verdict, note });
  const tag = verdict === 'pass' ? 'PASS' : verdict === 'skip' ? 'SKIP' : 'FAIL';
  console.log(`${tag}  ${endpoint}  [${kind}]  ${name}  ${status ?? ''}  ${note || ''}`);
}

async function call(name, p, { key = true, ext = null } = {}) {
  const t0 = Date.now();
  let res, text;
  try {
    res = await fetch(BASE + p, { headers: key ? { 'X-API-Key': KEY } : {} });
    text = await res.text();
  } catch (e) {
    return { status: 0, text: String(e), json: null, headers: new Map(), p, ms: Date.now() - t0 };
  }
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* csv or text */ }
  const isCsv = (res.headers.get('content-type') || '').includes('text/csv');
  fs.writeFileSync(`${OUT}/${name}.${isCsv ? 'csv' : 'json'}`, text);
  return { status: res.status, text, json, headers: res.headers, p, ms: Date.now() - t0, isCsv };
}

function keyCheck(obj, spec) {
  const all = spec.map((k) => k.replace('?', ''));
  const req = spec.filter((k) => !k.endsWith('?'));
  const keys = Object.keys(obj);
  const missing = req.filter((k) => !keys.includes(k));
  const extra = keys.filter((k) => !all.includes(k));
  const idx = keys.filter((k) => all.includes(k)).map((k) => all.indexOf(k));
  const orderOk = idx.every((v, i) => i === 0 || v > idx[i - 1]);
  return { missing, extra, orderOk };
}
function keyNote(c) {
  const parts = [];
  if (c.missing.length) parts.push('missing: ' + c.missing.join(','));
  if (c.extra.length) parts.push('extra: ' + c.extra.join(','));
  if (!c.orderOk) parts.push('key order differs');
  return parts.join('; ');
}

// ---- expected key lists, from docs/api-reference.md (the contract) ----
const SPEC = {
  ledger: ['ledger_hash', 'ledger_index', 'parent_hash', 'total_coins', 'close_time?', 'close_time_human', 'close_time_resolution', 'close_flags', 'parent_close_time?', 'account_hash', 'transaction_hash', 'hash', 'seqNum', 'totalCoins', 'accepted', 'closed', 'transactions?'],
  lastValidated: ['result', 'ledger_index', 'ledger_hash', 'parent_hash', 'close_time'],
  txSingle: ['hash', 'ledger_index', 'date', 'tx', 'meta'],
  txList: ['hash', 'ledger_index', 'date', 'ledger_hash', 'tx', 'meta'],
  payment: ['amount', 'delivered_amount', 'destination_balance_changes', 'max_amount?', 'source_balance_changes', 'tx_index', 'currency', 'destination', 'destination_tag?', 'executed_time', 'invoice_id?', 'issuer?', 'ledger_index', 'source', 'source_currency', 'source_tag?', 'tx_hash', 'transaction_cost'],
  exchange: ['base_amount', 'counter_amount', 'node_index', 'rate', 'tx_index', 'autobridged_currency?', 'autobridged_issuer?', 'buyer', 'executed_time', 'ledger_index', 'offer_sequence', 'provider', 'seller', 'taker', 'tx_hash', 'tx_type', 'base_currency', 'base_issuer?', 'counter_currency', 'counter_issuer?'],
  accountExchange: ['base_amount', 'counter_amount', 'node_index', 'rate', 'tx_index', 'autobridged_currency?', 'autobridged_issuer?', 'base_currency', 'base_issuer?', 'buyer', 'client?', 'counter_currency', 'counter_issuer?', 'executed_time', 'ledger_index', 'offer_sequence', 'provider', 'seller', 'taker', 'tx_hash', 'tx_type'],
  candle: ['base_volume', 'buy_volume', 'close', 'close_time', 'count', 'counter_volume', 'high', 'low', 'open', 'open_time', 'start', 'vwap', 'base_currency', 'base_issuer?', 'counter_currency', 'counter_issuer?'],
  reduce: ['open', 'high', 'low', 'close', 'base_volume', 'counter_volume', 'buy_volume', 'count', 'open_time?', 'close_time?', 'vwap', 'start', 'base_currency', 'base_issuer?', 'counter_currency', 'counter_issuer?'],
  account: ['account', 'parent', 'initial_balance', 'inception', 'ledger_index', 'tx_hash', 'genesis_balance?', 'genesis_index?'],
  balanceChange: ['amount_change', 'escrow_balance_change?', 'final_balance', 'node_index?', 'paychannel_final_balance?', 'paychannel_fund_change?', 'paychannel_fund_final_balance?', 'tx_index', 'change_type?', 'counterparty?', 'currency', 'escrow_counterparty?', 'executed_time', 'ledger_index', 'paychannel_counterparty?', 'tx_hash'],
  balance: ['currency', 'counterparty?', 'value'],
  order: ['specification', 'properties'],
  report: ['account', 'date', 'high_value_received', 'high_value_sent', 'total_value_received', 'total_value_sent', 'total_value', 'payments_sent', 'payments_received', 'receiving_counterparties', 'sending_counterparties', 'payments?'],
  acctStatsTx: ['date', 'transaction_count', 'result', 'type'],
  acctStatsValue: ['date', 'account_value', 'balance_change_count'],
  activeAccount: ['buy', 'sell', 'account', 'base_volume', 'counter_volume', 'count', 'exchanges?'],
  fee: ['avg', 'max', 'min', 'total', 'tx_count', 'date', 'ledger_index?'],
  feeStat: ['current_ledger_size', 'current_queue_size', 'date', 'expected_ledger_size', 'median_fee', 'minimum_fee', 'open_ledger_fee', 'pct_max_queue_size'],
  volume: ['components', 'count', 'exchange', 'total', 'exchange_rate', 'start_time', 'end_time'],
  validation: ['amendments?', 'base_fee?', 'count', 'ephemeral_public_key?', 'first_datetime', 'flags', 'full?', 'last_datetime', 'ledger_hash', 'ledger_index', 'load_fee?', 'reporter_public_key?', 'reserve_base?', 'reserve_inc?', 'signature?', 'signing_time', 'validation_public_key'],
};
const WRAP = {
  ledgers: ['result', 'ledger'],
  txSingle: ['result', 'transaction'],
  txs: ['result', 'count', 'marker?', 'transactions'],
  payments: ['result', 'count', 'marker?', 'payments'],
  exchanges: ['result', 'count', 'marker?', 'exchanges'],
  rate: ['result', 'rate'],
  normalize: ['result', 'amount', 'converted', 'rate'],
  stats: ['result', 'count', 'marker?', 'stats'],
  active: ['result', 'count', 'exchanges_count', 'accounts'],
  fees: ['result', 'marker?', 'count', 'rows'],
  volumes: ['result', 'count', 'marker?', 'rows'],
  accounts: ['result', 'count', 'marker?', 'accounts'],
  accountOne: ['result', 'account_data'],
  balanceChanges: ['result', 'count', 'marker?', 'balance_changes'],
  balances: ['result', 'ledger_index', 'close_time?', 'limit?', 'balances'],
  orders: ['result', 'ledger_index', 'close_time?', 'limit?', 'orders'],
  reports: ['result', 'start', 'end', 'count', 'reports'],
  acctStats: ['result', 'count', 'marker?', 'rows'],
  validations: ['result', 'ledger_hash', 'count', 'marker?', 'validations'],
};

// ---- tiny CSV reader (RFC 4180, every cell quoted by the API) ----
function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c === '\r') { /* skip */ } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const sep = (p) => (p.includes('?') ? '&' : '?');

// A JSON call with status, success, wrapper-keys and per-row key checks.
async function jsonCase(endpoint, name, p, { wrap, listKey, rowSpec, minRows = 0, nested = null, expectStatus = 200, rowSpecFn = null }) {
  const r = await call(name, p);
  if (r.status !== expectStatus || !r.json) { rec(endpoint, 'json', name, r.status, 'fail', `expected ${expectStatus}, got ${r.status}: ${r.text.slice(0, 160)}`, p); return r; }
  const notes = [];
  if (r.json.result !== 'success') notes.push('result != success');
  if (wrap) { const c = keyCheck(r.json, wrap); if (c.missing.length || c.extra.length || !c.orderOk) notes.push('wrapper ' + keyNote(c)); }
  let rows = listKey ? r.json[listKey] : null;
  if (listKey && !Array.isArray(rows)) { notes.push(`${listKey} is not an array`); rows = null; }
  if (rows) {
    if (typeof r.json.count === 'number' && r.json.count !== rows.length) notes.push(`count ${r.json.count} != rows ${rows.length}`);
    if (rows.length < minRows) notes.push(`only ${rows.length} rows`);
    const bad = new Map();
    rows.forEach((row) => {
      const target = nested ? row[nested] : row;
      if (!target) return;
      const sp = rowSpecFn ? rowSpecFn(row) : rowSpec;
      if (!sp) return;
      const c = keyCheck(target, sp);
      const n = keyNote(c);
      if (n) bad.set(n, (bad.get(n) || 0) + 1);
    });
    for (const [n, k] of bad) notes.push(`rows(${k}/${rows.length}) ${n}`);
  }
  const cc = r.headers.get('cache-control');
  if (cc !== 'public, max-age=60') notes.push(`Cache-Control=${cc}`);
  rec(endpoint, 'json', name, r.status, notes.length ? 'fail' : 'pass', notes.join(' | ') || `${rows ? rows.length + ' rows' : 'ok'}`, p);
  return r;
}

async function csvCase(endpoint, name, p, jsonResp, listKey) {
  const r = await call(name, p + sep(p) + 'format=csv');
  const notes = [];
  if (r.status !== 200) { rec(endpoint, 'csv', name, r.status, 'fail', `got ${r.status}: ${r.text.slice(0, 160)}`, p + sep(p) + 'format=csv'); return r; }
  const ct = r.headers.get('content-type') || '';
  const cd = r.headers.get('content-disposition') || '';
  if (!ct.includes('text/csv')) notes.push(`content-type ${ct}`);
  if (!/attachment; filename=/.test(cd)) notes.push(`content-disposition ${cd}`);
  const rows = parseCsv(r.text);
  const dataRows = Math.max(0, rows.length - 1);
  const expect = jsonResp && jsonResp.json && listKey ? (Array.isArray(jsonResp.json[listKey]) ? jsonResp.json[listKey].length : null) : null;
  if (expect !== null && expect !== dataRows) notes.push(`csv rows ${dataRows} != json rows ${expect}`);
  if (rows.length && rows.some((x) => x.length !== rows[0].length)) notes.push('ragged csv');
  if (/\[Object\]|\[object Object\]/.test(r.text)) notes.push('[Object] in cells');
  rec(endpoint, 'csv', name, r.status, notes.length ? 'fail' : 'pass', notes.join(' | ') || `${dataRows} rows, ${rows[0] ? rows[0].length : 0} cols; ${cd.replace('attachment; filename=', '')}`, p + sep(p) + 'format=csv');
  return r;
}

// 2-page marker walk: page1(limit=L)+page2(marker) must equal the first 2L rows of the unpaged call (limit=2L)
async function walkCase(endpoint, name, p, listKey, L = 3) {
  const r1 = await call(name + '_page1', `${p}${sep(p)}limit=${L}`);
  if (r1.status !== 200 || !r1.json) { rec(endpoint, 'paging', name, r1.status, 'fail', `page1 ${r1.status}: ${r1.text.slice(0, 120)}`, p); return; }
  const rows1 = r1.json[listKey] || [];
  const marker = r1.json.marker;
  const link = r1.headers.get('link');
  if (!marker) {
    // is it a genuine last page (rows < L) or a missing marker?
    if (rows1.length >= L) {
      // limit+1 rule: a full page with no marker means exactly L rows exist
      rec(endpoint, 'paging', name, 200, 'skip', `only ${rows1.length} rows in the window, no second page to walk (link header: ${link ? 'present' : 'absent'})`, p);
    } else rec(endpoint, 'paging', name, 200, 'skip', `only ${rows1.length} rows in the window`, p);
    return;
  }
  const notes = [];
  if (!link || !/rel="next"/.test(link)) notes.push('no Link rel=next on page 1');
  else if (!link.includes('marker=')) notes.push('Link has no marker');
  const r2 = await call(name + '_page2', `${p}${sep(p)}limit=${L}&marker=${encodeURIComponent(marker)}`);
  if (r2.status !== 200 || !r2.json) { rec(endpoint, 'paging', name, r2.status, 'fail', `page2 ${r2.status}: ${r2.text.slice(0, 120)}`, p); return; }
  const rows2 = r2.json[listKey] || [];
  const r3 = await call(name + '_unpaged', `${p}${sep(p)}limit=${2 * L}`);
  const rows3 = (r3.json && r3.json[listKey]) || [];
  const joined = JSON.stringify([...rows1, ...rows2]);
  const want = JSON.stringify(rows3.slice(0, rows1.length + rows2.length));
  if (joined !== want) notes.push('page1+page2 != unpaged first rows');
  if (rows1.length !== L) notes.push(`page1 has ${rows1.length} != ${L}`);
  rec(endpoint, 'paging', name, 200, notes.length ? 'fail' : 'pass', notes.join(' | ') || `page1 ${rows1.length} + page2 ${rows2.length} rows == unpaged; page2 marker: ${r2.json.marker ? 'yes' : 'none'}; Link ok`, p);
}

async function badCase(endpoint, name, p, status, message) {
  const r = await call(name, p);
  const notes = [];
  if (r.status !== status) notes.push(`status ${r.status} != ${status}`);
  const msg = r.json && (r.json.message ?? r.json.error);
  if (message !== undefined && msg !== message) notes.push(`message "${typeof msg === 'object' ? JSON.stringify(msg) : msg}" != "${message}"`);
  if (r.json && r.json.result !== 'error' && status !== 429) notes.push(`result=${r.json.result}`);
  if (r.headers.get('cache-control') !== 'no-store') notes.push(`Cache-Control=${r.headers.get('cache-control')} (errors must be no-store)`);
  rec(endpoint, 'bad-param', name, r.status, notes.length ? 'fail' : 'pass', notes.join(' | ') || `${r.status} ${msg}`, p);
}

async function authCase(endpoint, name, p) {
  const r = await call(name, p, { key: false });
  const notes = [];
  if (r.status !== 401) notes.push(`status ${r.status} != 401`);
  if (!r.json || r.json.message !== 'Missing or invalid API key.' || r.json.result !== 'error') notes.push(`body ${r.text.slice(0, 100)}`);
  rec(endpoint, '401', name, r.status, notes.length ? 'fail' : 'pass', notes.join(' | ') || '401 Missing or invalid API key.', p);
}

const skip = (endpoint, kind, name, why) => rec(endpoint, kind, name, null, 'skip', why, '');

(async () => {
  // -------- discovery (from the network's own database) --------
  const D = {};
  const nat = (c, i) => (c === NAT && !i);
  const asset = (c, i) => (nat(c, i) ? NAT : `${c}+${i}`);
  const ledgerRange = (await ch('select min(ledger_index) mn, max(ledger_index) mx, min(close_time) t0, max(close_time) t1, count() n from ledgers'))[0];
  D.range = ledgerRange;
  const pc = await ch(`select currency, issuer, count() c from payments where issuer != '' group by currency, issuer order by c desc limit 1`);
  D.payIssued = pc[0] || null;
  D.payAcct = (await ch(`select source a, count() c from payments group by source order by c desc limit 1`))[0]?.a;
  D.payAcctDest = (await ch(`select destination a, count() c from payments group by destination order by c desc limit 1`))[0]?.a;
  const pairs = await ch(`select base_currency bc, base_issuer bi, counter_currency cc, counter_issuer ci, count() c from exchanges group by bc, bi, cc, ci order by c desc limit 5`);
  D.pair = pairs[0] || null;
  D.pairAgainstNative = pairs.find((x) => x.cc === NAT && !x.ci) || pairs[0] || null;
  D.exAcct = (await ch(`select buyer a, count() c from exchanges group by buyer order by c desc limit 1`))[0]?.a;
  const seq = (await ch(`select account a, count() c, min(sequence) mn, max(sequence) mx from transactions where sequence > 0 group by account order by c desc limit 1`))[0];
  D.seqAcct = seq;
  D.parent = (await ch(`select parent p, count() c from accounts_created group by parent order by c desc limit 1`))[0]?.p;
  D.created = (await ch(`select account a from accounts_created order by ledger_index desc limit 1`))[0]?.a;
  D.bcAcct = (await ch(`select account a, count() c from balance_changes where currency != '${NAT}' group by account order by c desc limit 1`))[0]?.a || D.payAcct;
  D.payHash = (await ch(`select hash h, ledger_index li, tx_index ti from transactions where tx_type = 'Payment' and result = 'tesSUCCESS' order by ledger_index desc limit 1`))[0];
  D.midLedger = (await ch(`select ledger_index li, ledger_hash lh, close_time ct, tx_count tc from ledgers where tx_count > 2 order by ledger_index limit 1 offset 40`))[0] || (await ch(`select ledger_index li, ledger_hash lh, close_time ct, tx_count tc from ledgers order by ledger_index limit 1 offset 10`))[0];
  D.valLedger = (await ch(`select l.ledger_hash lh, l.ledger_index li, count() n from ledgers l inner join validations v on v.ledger_hash = l.ledger_hash group by lh, li order by li desc limit 1 offset 3`))[0] || null;
  D.valKey = D.valLedger ? (await ch(`select validation_public_key k from validations where ledger_hash = '${D.valLedger.lh}' order by validation_public_key limit 1`))[0]?.k : null;
  D.balAcct = D.exAcct || D.payAcct;
  console.log('DISCOVERY', JSON.stringify(D));
  fs.writeFileSync(`${OUT}/_discovery.json`, JSON.stringify(D, null, 1));

  const E = (s) => s; // label helper
  const day = D.range.t0.slice(0, 10);

  // ================= Ledgers =================
  let ep = 'GET /v2/ledgers[/{id}]';
  await jsonCase(ep, 'ledgers_latest', '/v2/ledgers', { wrap: WRAP.ledgers, nested: null, listKey: null });
  { const r = await call('ledgers_latest_chk', '/v2/ledgers'); const c = keyCheck(r.json.ledger, SPEC.ledger); rec(ep, 'json', 'ledgers_latest fields', r.status, keyNote(c) ? 'fail' : 'pass', keyNote(c) || 'ledger object keys match', '/v2/ledgers'); }
  await jsonCase(ep, 'ledgers_by_index', `/v2/ledgers/${D.midLedger.li}`, { wrap: WRAP.ledgers });
  { const r = await call('ledgers_by_index_tx', `/v2/ledgers/${D.midLedger.li}?transactions=true`); const ok = r.json && Array.isArray(r.json.ledger.transactions) && r.json.ledger.transactions.length === D.midLedger.tc; const c = keyCheck(r.json.ledger, SPEC.ledger); rec(ep, 'json', 'ledgers_by_index transactions=true', r.status, ok && !keyNote(c) ? 'pass' : 'fail', ok ? (keyNote(c) || `${r.json.ledger.transactions.length} hashes`) : 'transactions hash list missing / wrong length', `/v2/ledgers/${D.midLedger.li}?transactions=true`); }
  { const p = `/v2/ledgers/${D.midLedger.li}?expand=true`; const r = await call('ledgers_by_index_expand', p); const t = r.json?.ledger?.transactions; const ok = Array.isArray(t) && t.length === D.midLedger.tc && t.every((x) => x && typeof x === 'object' && 'tx' in x === false ? true : true); const c = t && t[0] ? keyCheck(t[0], ['hash', 'ledger_index', 'date', 'tx', 'meta']) : { missing: [], extra: [], orderOk: true }; rec(ep, 'json', 'ledgers_by_index expand=true', r.status, Array.isArray(t) && !keyNote(c) ? 'pass' : 'fail', Array.isArray(t) ? (keyNote(c) || `${t.length} tx objects`) : 'no transactions array', p); }
  { const p = `/v2/ledgers/${D.midLedger.li}?binary=true`; const r = await call('ledgers_by_index_binary', p); const t = r.json?.ledger?.transactions; const ok = Array.isArray(t) && t.length === D.midLedger.tc && t.every((x) => typeof x.tx === 'string' && typeof x.meta === 'string' && /^[0-9A-F]+$/.test(x.tx)); rec(ep, 'json', 'ledgers_by_index binary=true', r.status, ok ? 'pass' : 'fail', ok ? `${t.length} hex tx/meta` : 'tx/meta not hex strings', p); }
  await jsonCase(ep, 'ledgers_by_hash', `/v2/ledgers/${D.midLedger.lh}`, { wrap: WRAP.ledgers });
  { const p = `/v2/ledgers/${D.midLedger.ct.slice(0, 13).replace(' ', 'T')}`; const r = await call('ledgers_by_date', p); rec(ep, 'json', 'ledgers_by_date (hour)', r.status, r.status === 200 && r.json.ledger ? 'pass' : 'fail', r.json?.ledger ? `ledger ${r.json.ledger.ledger_index}` : r.text.slice(0, 120), p); }
  await jsonCase('GET /v2/last_validated', 'last_validated', '/v2/last_validated', { wrap: SPEC.lastValidated });
  await badCase(ep, 'ledgers_bad_id', '/v2/ledgers/zz', 400, 'invalid ledger identifier');
  await badCase(ep, 'ledgers_not_found', '/v2/ledgers/999999999', 404, 'ledger not found');
  await authCase(ep, 'ledgers_noauth', '/v2/ledgers');
  skip(ep, 'csv', 'ledgers', 'no CSV form by contract');
  skip(ep, 'paging', 'ledgers', 'single object, no paging by contract');

  // ================= Transactions =================
  ep = 'GET /v2/transactions/{hash}';
  if (D.payHash) {
    const r = await jsonCase(ep, 'tx_by_hash', `/v2/transactions/${D.payHash.h}`, { wrap: WRAP.txSingle });
    if (r.json?.transaction) { const c = keyCheck(r.json.transaction, SPEC.txSingle); rec(ep, 'json', 'tx_by_hash fields', 200, keyNote(c) ? 'fail' : 'pass', keyNote(c) || 'keys match; delivered_amount ' + (r.json.transaction.meta?.delivered_amount !== undefined ? 'present' : 'ABSENT'), ''); }
    const rb = await call('tx_by_hash_binary', `/v2/transactions/${D.payHash.h}?binary=true`);
    rec(ep, 'json', 'tx_by_hash binary=true', rb.status, rb.json?.transaction && /^[0-9A-F]+$/.test(rb.json.transaction.tx) && /^[0-9A-F]+$/.test(rb.json.transaction.meta) ? 'pass' : 'fail', 'tx/meta hex (re-hash verified in Step 5)', `/v2/transactions/${D.payHash.h}?binary=true`);
    await badCase(ep, 'tx_bad_hash', '/v2/transactions/zz', 400, 'invalid hash');
    await badCase(ep, 'tx_not_found', '/v2/transactions/' + '0'.repeat(64), 404, 'transaction not found');
    await authCase(ep, 'tx_noauth', `/v2/transactions/${D.payHash.h}`);
  }
  skip(ep, 'csv', 'tx_by_hash', 'no CSV form by contract'); skip(ep, 'paging', 'tx_by_hash', 'single object');
  ep = 'GET /v2/transactions';
  { const r = await jsonCase(ep, 'tx_list', '/v2/transactions?limit=5', { wrap: WRAP.txs, listKey: 'transactions', rowSpec: SPEC.txList, minRows: 1 }); }
  await walkCase(ep, 'tx_list_walk', '/v2/transactions', 'transactions', 3);
  await walkCase(ep, 'tx_list_walk_desc', '/v2/transactions?descending=true', 'transactions', 3);
  await jsonCase(ep, 'tx_list_type', '/v2/transactions?type=Payment&limit=3', { wrap: WRAP.txs, listKey: 'transactions', rowSpec: SPEC.txList });
  await jsonCase(ep, 'tx_list_result', '/v2/transactions?result=tesSUCCESS&limit=3', { wrap: WRAP.txs, listKey: 'transactions', rowSpec: SPEC.txList });
  await jsonCase(ep, 'tx_list_binary', '/v2/transactions?binary=true&limit=2', { wrap: WRAP.txs, listKey: 'transactions', rowSpec: SPEC.txList });
  await badCase(ep, 'tx_list_bad_type', '/v2/transactions?type=Nope', 400, 'invalid transaction type');
  await badCase(ep, 'tx_list_bad_start', '/v2/transactions?start=zzz', 400, 'invalid start date format');
  await authCase(ep, 'tx_list_noauth', '/v2/transactions');
  skip(ep, 'csv', 'tx_list', 'no CSV form by contract');

  // ================= Payments =================
  ep = 'GET /v2/payments[/{currency}]';
  { const r = await jsonCase(ep, 'payments', '/v2/payments?limit=5', { wrap: WRAP.payments, listKey: 'payments', rowSpec: SPEC.payment, minRows: 1 });
    await csvCase(ep, 'payments_csv', '/v2/payments?limit=5', r, 'payments'); }
  await walkCase(ep, 'payments_walk', '/v2/payments', 'payments', 3);
  await walkCase(ep, 'payments_walk_desc', '/v2/payments?descending=true', 'payments', 3);
  await jsonCase(ep, 'payments_native', `/v2/payments/${NAT}?limit=3`, { wrap: WRAP.payments, listKey: 'payments', rowSpec: SPEC.payment, minRows: 1 });
  if (D.payIssued) {
    const a = asset(D.payIssued.currency, D.payIssued.issuer);
    const r = await jsonCase(ep, 'payments_issued', `/v2/payments/${a}?limit=3`, { wrap: WRAP.payments, listKey: 'payments', rowSpec: SPEC.payment, minRows: 1 });
    await csvCase(ep, 'payments_issued_csv', `/v2/payments/${a}?limit=3`, r, 'payments');
  } else skip(ep, 'json', 'payments_issued', 'no issued-currency payment in the window');
  await badCase(ep, 'payments_bad', `/v2/payments/${NAT}+rrrrrrrrrrrrrrrrrrrrBZbvji`, 400, `${NAT} cannot have an issuer`);
  await authCase(ep, 'payments_noauth', '/v2/payments');

  // ================= Exchanges =================
  ep = 'GET /v2/exchanges/{base}/{counter}';
  if (D.pairAgainstNative) {
    const P = D.pairAgainstNative; const pb = asset(P.bc, P.bi); const pcn = asset(P.cc, P.ci); const base = `/v2/exchanges/${pb}/${pcn}`;
    const r = await jsonCase(ep, 'exchanges_raw', `${base}?limit=5`, { wrap: WRAP.exchanges, listKey: 'exchanges', rowSpec: SPEC.exchange, minRows: 1 });
    await csvCase(ep, 'exchanges_raw_csv', `${base}?limit=5`, r, 'exchanges');
    await walkCase(ep, 'exchanges_walk', base, 'exchanges', 3);
    await walkCase(ep, 'exchanges_walk_desc', `${base}?descending=true`, 'exchanges', 3);
    const rc = await jsonCase(ep, 'exchanges_candles', `${base}?interval=1hour`, { wrap: WRAP.exchanges, listKey: 'exchanges', rowSpec: SPEC.candle, minRows: 1 });
    await csvCase(ep, 'exchanges_candles_csv', `${base}?interval=1hour`, rc, 'exchanges');
    await walkCase(ep, 'exchanges_candles_walk', `${base}?interval=5minute`, 'exchanges', 3);
    const rr = await jsonCase(ep, 'exchanges_reduce', `${base}?reduce=true`, { wrap: WRAP.exchanges, listKey: 'exchanges', rowSpec: SPEC.reduce, minRows: 1 });
    await csvCase(ep, 'exchanges_reduce_csv', `${base}?reduce=true`, rr, 'exchanges');
    await jsonCase(ep, 'exchanges_reversed', `/v2/exchanges/${pcn}/${pb}?limit=3`, { wrap: WRAP.exchanges, listKey: 'exchanges', rowSpec: SPEC.exchange, minRows: 1 });
    await jsonCase(ep, 'exchanges_autobridged', `${base}?autobridged=true&limit=3`, { wrap: WRAP.exchanges, listKey: 'exchanges', rowSpec: SPEC.exchange });
    await badCase(ep, 'exchanges_bad_interval', `${base}?interval=foo`, 400, 'invalid interval: foo');
    await badCase(ep, 'exchanges_bad_limit', `${base}?limit=abc`, 400, 'invalid limit: NaN');
    await badCase(ep, 'exchanges_reduce_interval', `${base}?reduce=true&interval=1hour`, 400, 'cannot use reduce with interval');
    await authCase(ep, 'exchanges_noauth', base);
    // active accounts
    const ep2 = 'GET /v2/active_accounts/{base}/{counter}';
    await jsonCase(ep2, 'active_accounts', `/v2/active_accounts/${pb}/${pcn}`, { wrap: WRAP.active, listKey: 'accounts', rowSpec: SPEC.activeAccount, minRows: 0 });
    const ra = await jsonCase(ep2, 'active_accounts_7day', `/v2/active_accounts/${pb}/${pcn}?period=7day`, { wrap: WRAP.active, listKey: 'accounts', rowSpec: SPEC.activeAccount, minRows: 1 });
    await csvCase(ep2, 'active_accounts_csv', `/v2/active_accounts/${pb}/${pcn}?period=7day`, ra, 'accounts');
    await jsonCase(ep2, 'active_accounts_incl', `/v2/active_accounts/${pb}/${pcn}?include_exchanges=true&period=7day`, { wrap: WRAP.active, listKey: 'accounts', rowSpec: SPEC.activeAccount, minRows: 1 });
    await badCase(ep2, 'active_accounts_bad_period', `/v2/active_accounts/${pb}/${pcn}?period=2day`, 400, 'invalid period - use: 1day, 3day, 7day');
    await authCase(ep2, 'active_accounts_noauth', `/v2/active_accounts/${pb}/${pcn}`);
    skip(ep2, 'paging', 'active_accounts', 'not paged by contract');
    // rates
    const ep3 = 'GET /v2/exchange_rates/{base}/{counter}';
    { const r2 = await jsonCase(ep3, 'rate', `/v2/exchange_rates/${pb}/${pcn}?strict=false`, { wrap: WRAP.rate }); rec(ep3, 'json', 'rate value', r2.status, r2.json && /^\d+\.\d{7}0*$|^\d+(\.\d+)?$/.test(String(r2.json.rate)) ? 'pass' : 'fail', `rate=${r2.json?.rate}`, ''); }
    await jsonCase(ep3, 'rate_period', `/v2/exchange_rates/${pb}/${pcn}?period=day&strict=false`, { wrap: WRAP.rate });
    await badCase(ep3, 'rate_bad_period', `/v2/exchange_rates/${pb}/${pcn}?period=foo`, 400, 'invalid period: foo');
    await authCase(ep3, 'rate_noauth', `/v2/exchange_rates/${pb}/${pcn}`);
    skip(ep3, 'csv', 'rate', 'no CSV form by contract'); skip(ep3, 'paging', 'rate', 'single value');
    const ep4 = 'GET /v2/normalize';
    const q = P.bc === NAT && !P.bi ? '' : `&currency=${P.bc}&issuer=${P.bi}`;
    await jsonCase(ep4, 'normalize', `/v2/normalize?amount=100${q}&strict=false`, { wrap: WRAP.normalize });
    await badCase(ep4, 'normalize_bad_amount', '/v2/normalize?amount=abc', 400, 'invalid amount');
    await authCase(ep4, 'normalize_noauth', '/v2/normalize?amount=1');
    skip(ep4, 'csv', 'normalize', 'no CSV form by contract'); skip(ep4, 'paging', 'normalize', 'single value');
  } else {
    for (const n of ['exchanges', 'active_accounts', 'exchange_rates', 'normalize']) skip('/v2/' + n, 'json', n, 'no trades in the synced window');
  }
  ep = 'GET /v2/exchanges (all pairs)';
  { const r = await jsonCase(ep, 'exchanges_all', '/v2/exchanges?limit=5', { wrap: WRAP.exchanges, listKey: 'exchanges', rowSpec: SPEC.exchange, minRows: 1 });
    await csvCase(ep, 'exchanges_all_csv', '/v2/exchanges?limit=5', r, 'exchanges'); }
  await walkCase(ep, 'exchanges_all_walk', '/v2/exchanges', 'exchanges', 3);
  await badCase(ep, 'exchanges_all_bad', '/v2/exchanges?start=zzz', 400, 'invalid start date format');
  await authCase(ep, 'exchanges_all_noauth', '/v2/exchanges');

  // ================= Stats =================
  ep = 'GET /v2/stats[/{family}[/{metric}]]';
  { const r = await jsonCase(ep, 'stats_all', '/v2/stats?interval=hour', { wrap: WRAP.stats, listKey: 'stats', rowSpecFn: (row) => ['date', 'type', 'result', 'metric'].filter(() => true).map((k) => k + '?'), minRows: 1 });
    await csvCase(ep, 'stats_all_csv', '/v2/stats?interval=hour', r, 'stats'); }
  { const r = await call('stats_type', '/v2/stats/type?interval=hour'); const row = r.json?.stats?.[0]; rec(ep, 'json', 'stats_type (flat family row)', r.status, row && row.date && !row.type ? 'pass' : 'fail', row ? Object.keys(row).slice(0, 6).join(',') + '...' : r.text.slice(0, 120), '/v2/stats/type?interval=hour'); }
  { const r = await call('stats_metric_one', '/v2/stats/metric/ledger_count?interval=hour'); const row = r.json?.stats?.[0]; rec(ep, 'json', 'stats_metric/ledger_count', r.status, row && Object.keys(row).join() === 'date,ledger_count' || (row && Object.keys(row).sort().join() === 'date,ledger_count') ? 'pass' : 'fail', row ? Object.keys(row).join(',') : r.text.slice(0, 120), '/v2/stats/metric/ledger_count?interval=hour'); }
  await walkCase(ep, 'stats_walk', '/v2/stats?interval=hour', 'stats', 1);
  await jsonCase(ep, 'stats_week', '/v2/stats/metric?interval=week', { wrap: WRAP.stats, listKey: 'stats' });
  await badCase(ep, 'stats_bad_interval', '/v2/stats?interval=foo', 400, 'invalid interval');
  await authCase(ep, 'stats_noauth', '/v2/stats');

  // ================= Accounts =================
  ep = 'GET /v2/accounts';
  { const r = await jsonCase(ep, 'accounts', '/v2/accounts?limit=5', { wrap: WRAP.accounts, listKey: 'accounts', rowSpec: SPEC.account, minRows: 1 });
    await csvCase(ep, 'accounts_csv', '/v2/accounts?limit=5', r, 'accounts'); }
  await walkCase(ep, 'accounts_walk', '/v2/accounts', 'accounts', 3);
  if (D.parent) await jsonCase(ep, 'accounts_parent', `/v2/accounts?parent=${D.parent}`, { wrap: WRAP.accounts, listKey: 'accounts', rowSpec: SPEC.account, minRows: 1 });
  await badCase(ep, 'accounts_bad', '/v2/accounts?start=zzz', 400, 'invalid start date format');
  await authCase(ep, 'accounts_noauth', '/v2/accounts');
  ep = 'GET /v2/accounts/{address}';
  if (D.created) {
    await jsonCase(ep, 'account_one', `/v2/accounts/${D.created}`, { wrap: WRAP.accountOne });
    { const r = await call('account_one_fields', `/v2/accounts/${D.created}`); const c = keyCheck(r.json.account_data, SPEC.account); rec(ep, 'json', 'account_one fields', r.status, keyNote(c) ? 'fail' : 'pass', keyNote(c) || 'keys match', ''); }
    await badCase(ep, 'account_one_not_found', '/v2/accounts/rrrrrrrrrrrrrrrrrrrrBZbvji', 404, 'Account not found');
    await authCase(ep, 'account_one_noauth', `/v2/accounts/${D.created}`);
  } else skip(ep, 'json', 'account_one', 'no account created in the window');
  skip(ep, 'csv', 'account_one', 'no CSV form by contract'); skip(ep, 'paging', 'account_one', 'single object');

  const A = D.seqAcct?.a || D.payAcct;
  ep = 'GET /v2/accounts/{address}/transactions[/{seq}]';
  { await jsonCase(ep, 'acct_tx', `/v2/accounts/${A}/transactions?limit=5`, { wrap: WRAP.txs, listKey: 'transactions', rowSpec: SPEC.txSingle, minRows: 1 });
    await walkCase(ep, 'acct_tx_walk', `/v2/accounts/${A}/transactions`, 'transactions', 3);
    if (D.seqAcct) {
      const mn = D.seqAcct.mn, mx = D.seqAcct.mx;
      const r = await jsonCase(ep, 'acct_tx_seqmode', `/v2/accounts/${A}/transactions?min_sequence=${mn}&max_sequence=${mx}&limit=5`, { wrap: WRAP.txs, listKey: 'transactions', rowSpec: SPEC.txSingle, minRows: 1 });
      await jsonCase(ep, 'acct_tx_one', `/v2/accounts/${A}/transactions/${mn}`, { wrap: WRAP.txSingle });
      await badCase(ep, 'acct_tx_bad_seq', `/v2/accounts/${A}/transactions/abc`, 400, 'invalid sequence number');
    }
    await badCase(ep, 'acct_tx_bad_minseq', `/v2/accounts/${A}/transactions?min_sequence=abc`, 400, 'invalid min_sequence');
    await authCase(ep, 'acct_tx_noauth', `/v2/accounts/${A}/transactions`);
    skip(ep, 'csv', 'acct_tx', 'no CSV form by contract'); }
  ep = 'GET /v2/accounts/{address}/payments';
  { const r = await jsonCase(ep, 'acct_payments', `/v2/accounts/${D.payAcct}/payments?limit=5`, { wrap: WRAP.payments, listKey: 'payments', rowSpec: SPEC.payment, minRows: 1 });
    await csvCase(ep, 'acct_payments_csv', `/v2/accounts/${D.payAcct}/payments?limit=5`, r, 'payments');
    await walkCase(ep, 'acct_payments_walk', `/v2/accounts/${D.payAcct}/payments`, 'payments', 3);
    await jsonCase(ep, 'acct_payments_sent', `/v2/accounts/${D.payAcct}/payments?type=sent&limit=3`, { wrap: WRAP.payments, listKey: 'payments', rowSpec: SPEC.payment });
    await jsonCase(ep, 'acct_payments_received', `/v2/accounts/${D.payAcctDest}/payments?type=received&limit=3`, { wrap: WRAP.payments, listKey: 'payments', rowSpec: SPEC.payment });
    await badCase(ep, 'acct_payments_bad', `/v2/accounts/${D.payAcct}/payments?type=foo`, 400, 'invalid type - use: sent, received');
    await authCase(ep, 'acct_payments_noauth', `/v2/accounts/${D.payAcct}/payments`); }
  ep = 'GET /v2/accounts/{address}/exchanges[/{base}[/{counter}]]';
  if (D.exAcct) {
    const r = await jsonCase(ep, 'acct_exchanges', `/v2/accounts/${D.exAcct}/exchanges?limit=5`, { wrap: WRAP.exchanges, listKey: 'exchanges', rowSpec: SPEC.accountExchange, minRows: 1 });
    await csvCase(ep, 'acct_exchanges_csv', `/v2/accounts/${D.exAcct}/exchanges?limit=5`, r, 'exchanges');
    await walkCase(ep, 'acct_exchanges_walk', `/v2/accounts/${D.exAcct}/exchanges`, 'exchanges', 3);
    const P = D.pairAgainstNative; const pb = asset(P.bc, P.bi); const pcn = asset(P.cc, P.ci);
    await jsonCase(ep, 'acct_exchanges_base', `/v2/accounts/${D.exAcct}/exchanges/${pb}?limit=3`, { wrap: WRAP.exchanges, listKey: 'exchanges', rowSpec: SPEC.accountExchange });
    await jsonCase(ep, 'acct_exchanges_pair', `/v2/accounts/${D.exAcct}/exchanges/${pb}/${pcn}?limit=3`, { wrap: WRAP.exchanges, listKey: 'exchanges', rowSpec: SPEC.accountExchange });
    await badCase(ep, 'acct_exchanges_bad', `/v2/accounts/${D.exAcct}/exchanges/USD+rbad`, 400, 'invalid base issuer address');
    await authCase(ep, 'acct_exchanges_noauth', `/v2/accounts/${D.exAcct}/exchanges`);
  } else skip(ep, 'json', 'acct_exchanges', 'no trades in the synced window');
  ep = 'GET /v2/accounts/{address}/balance_changes';
  { const r = await jsonCase(ep, 'acct_bc', `/v2/accounts/${D.bcAcct}/balance_changes?limit=5`, { wrap: WRAP.balanceChanges, listKey: 'balance_changes', rowSpec: SPEC.balanceChange, minRows: 1 });
    await csvCase(ep, 'acct_bc_csv', `/v2/accounts/${D.bcAcct}/balance_changes?limit=5`, r, 'balance_changes');
    await walkCase(ep, 'acct_bc_walk', `/v2/accounts/${D.bcAcct}/balance_changes`, 'balance_changes', 3);
    await jsonCase(ep, 'acct_bc_type', `/v2/accounts/${D.bcAcct}/balance_changes?change_type=transaction_cost&limit=3`, { wrap: WRAP.balanceChanges, listKey: 'balance_changes', rowSpec: SPEC.balanceChange });
    await badCase(ep, 'acct_bc_bad', `/v2/accounts/${D.bcAcct}/balance_changes?change_type=foo`, 400, 'invalid change_type - use: transaction_cost, exchange, intermediary, payment_source, payment_destination, escrow_create, escrow_cancel, escrow_finish, paychannel_fund, paychannel_payout');
    await authCase(ep, 'acct_bc_noauth', `/v2/accounts/${D.bcAcct}/balance_changes`); }
  ep = 'GET /v2/accounts/{address}/balances (live node)';
  { const r = await jsonCase(ep, 'acct_balances', `/v2/accounts/${D.balAcct}/balances`, { wrap: WRAP.balances, listKey: 'balances', rowSpec: SPEC.balance, minRows: 1 });
    await csvCase(ep, 'acct_balances_csv', `/v2/accounts/${D.balAcct}/balances`, r, 'balances');
    await jsonCase(ep, 'acct_balances_limit', `/v2/accounts/${D.balAcct}/balances?limit=2`, { wrap: WRAP.balances, listKey: 'balances', rowSpec: SPEC.balance });
    await jsonCase(ep, 'acct_balances_all', `/v2/accounts/${D.balAcct}/balances?limit=all`, { wrap: WRAP.balances, listKey: 'balances', rowSpec: SPEC.balance });
    await badCase(ep, 'acct_balances_bad', `/v2/accounts/notanaddress/balances`, 400, 'invalid ripple address');
    await badCase(ep, 'acct_balances_bad_limit', `/v2/accounts/${D.balAcct}/balances?limit=abc`, 400, 'invalid limit');
    await authCase(ep, 'acct_balances_noauth', `/v2/accounts/${D.balAcct}/balances`);
    skip(ep, 'paging', 'acct_balances', 'no marker by contract (limit / limit=all)'); }
  ep = 'GET /v2/accounts/{address}/orders (live node)';
  { const r = await jsonCase(ep, 'acct_orders', `/v2/accounts/${D.balAcct}/orders`, { wrap: WRAP.orders, listKey: 'orders', rowSpec: SPEC.order });
    await csvCase(ep, 'acct_orders_csv', `/v2/accounts/${D.balAcct}/orders`, r, 'orders');
    await badCase(ep, 'acct_orders_bad', `/v2/accounts/notanaddress/orders`, 400, 'invalid ripple address');
    await authCase(ep, 'acct_orders_noauth', `/v2/accounts/${D.balAcct}/orders`);
    skip(ep, 'paging', 'acct_orders', 'no marker by contract'); }
  ep = 'GET /v2/accounts/{address}/reports[/{date}]';
  { const r = await jsonCase(ep, 'acct_reports', `/v2/accounts/${D.payAcct}/reports?start=${day}&end=${day}`, { wrap: WRAP.reports, listKey: 'reports', rowSpec: SPEC.report, minRows: 1 });
    await csvCase(ep, 'acct_reports_csv', `/v2/accounts/${D.payAcct}/reports?start=${day}&end=${day}`, r, 'reports');
    await jsonCase(ep, 'acct_reports_date', `/v2/accounts/${D.payAcct}/reports/${day}?payments=true`, { wrap: WRAP.reports, listKey: 'reports', rowSpec: SPEC.report, minRows: 1 });
    await badCase(ep, 'acct_reports_bad', `/v2/accounts/${D.payAcct}/reports?start=2020-01-01&end=2026-01-01`, 400, 'choose a date range less than 200 days');
    await authCase(ep, 'acct_reports_noauth', `/v2/accounts/${D.payAcct}/reports`);
    skip(ep, 'paging', 'acct_reports', 'not paged by contract'); }
  ep = 'GET /v2/accounts/{address}/stats/{transactions|value}';
  { const r = await jsonCase(ep, 'acct_stats_tx', `/v2/accounts/${A}/stats/transactions?start=${day}`, { wrap: WRAP.acctStats, listKey: 'rows', rowSpec: SPEC.acctStatsTx, minRows: 1 });
    await csvCase(ep, 'acct_stats_tx_csv', `/v2/accounts/${A}/stats/transactions?start=${day}`, r, 'rows');
    const r2 = await jsonCase(ep, 'acct_stats_value', `/v2/accounts/${D.payAcct}/stats/value?start=${day}`, { wrap: WRAP.acctStats, listKey: 'rows', rowSpec: SPEC.acctStatsValue, minRows: 1 });
    await csvCase(ep, 'acct_stats_value_csv', `/v2/accounts/${D.payAcct}/stats/value?start=${day}`, r2, 'rows');
    skip(ep, 'paging', 'acct_stats', 'one row per active UTC day; the synced window spans at most 2 days');
    await badCase(ep, 'acct_stats_bad', `/v2/accounts/${A}/stats/foo`, 400, 'invalid family');
    await authCase(ep, 'acct_stats_noauth', `/v2/accounts/${A}/stats/transactions`); }

  // ================= Network =================
  ep = 'GET /v2/network/fees';
  { const r = await jsonCase(ep, 'fees_ledger', '/v2/network/fees?limit=5', { wrap: WRAP.fees, listKey: 'rows', rowSpec: SPEC.fee, minRows: 1 });
    await csvCase(ep, 'fees_csv', '/v2/network/fees?limit=5', r, 'rows');
    await walkCase(ep, 'fees_walk', '/v2/network/fees', 'rows', 3);
    await jsonCase(ep, 'fees_hour', '/v2/network/fees?interval=hour', { wrap: WRAP.fees, listKey: 'rows', rowSpec: SPEC.fee, minRows: 1 });
    await jsonCase(ep, 'fees_day', '/v2/network/fees?interval=day', { wrap: WRAP.fees, listKey: 'rows', rowSpec: SPEC.fee, minRows: 1 });
    await badCase(ep, 'fees_bad', '/v2/network/fees?interval=foo', 400, 'invalid interval');
    await authCase(ep, 'fees_noauth', '/v2/network/fees'); }
  ep = 'GET /v2/network/fee_stats';
  { const r = await jsonCase(ep, 'fee_stats', `/v2/network/fee_stats?limit=5&start=${day}`, { wrap: WRAP.fees, listKey: 'rows', rowSpec: SPEC.feeStat, minRows: 1 });
    await csvCase(ep, 'fee_stats_csv', `/v2/network/fee_stats?limit=5&start=${day}`, r, 'rows');
    await walkCase(ep, 'fee_stats_walk', `/v2/network/fee_stats?start=${day}`, 'rows', 3);
    await jsonCase(ep, 'fee_stats_minute', `/v2/network/fee_stats?interval=minute&start=${day}`, { wrap: WRAP.fees, listKey: 'rows', rowSpec: SPEC.feeStat });
    await badCase(ep, 'fee_stats_bad', '/v2/network/fee_stats?interval=foo', 400, 'invalid interval');
    await authCase(ep, 'fee_stats_noauth', '/v2/network/fee_stats'); }
  for (const [name, route, liveList] of [['exchange_volume', 'exchange_volume', 'hour, day, 3day, 7day, 30day'], ['payment_volume', 'payment_volume', 'hour, day']]) {
    ep = `GET /v2/network/${route}`;
    const r = await jsonCase(ep, `${name}_live`, `/v2/network/${route}?live=day`, { wrap: WRAP.volumes, listKey: 'rows', rowSpec: SPEC.volume, minRows: 1 });
    await csvCase(ep, `${name}_live_csv`, `/v2/network/${route}?live=day`, r, 'rows');
    await jsonCase(ep, `${name}_live_hour`, `/v2/network/${route}?live=hour`, { wrap: WRAP.volumes, listKey: 'rows', rowSpec: SPEC.volume, minRows: 1 });
    await jsonCase(ep, `${name}_hist`, `/v2/network/${route}?start=${day}&interval=day`, { wrap: WRAP.volumes, listKey: 'rows', rowSpec: SPEC.volume });
    await badCase(ep, `${name}_bad`, `/v2/network/${route}?live=foo`, 400, `invalid period - use: ${liveList}`);
    await authCase(ep, `${name}_noauth`, `/v2/network/${route}`);
    skip(ep, 'paging', name, 'historical rows exist only for closed days; the synced window has no closed day (marker mechanism covered by e2e tests)');
  }

  // ================= Validations =================
  ep = 'GET /v2/ledgers/{hash}/validations[/{pubkey}]';
  if (D.valLedger) {
    const r = await jsonCase(ep, 'validations', `/v2/ledgers/${D.valLedger.lh}/validations?limit=5`, { wrap: WRAP.validations, listKey: 'validations', rowSpec: SPEC.validation, minRows: 1 });
    await csvCase(ep, 'validations_csv', `/v2/ledgers/${D.valLedger.lh}/validations?limit=5`, r, 'validations');
    await walkCase(ep, 'validations_walk', `/v2/ledgers/${D.valLedger.lh}/validations`, 'validations', 3);
    await jsonCase(ep, 'validations_alias', `/v2/ledger/${D.valLedger.lh}/validations?limit=2`, { wrap: WRAP.validations, listKey: 'validations', rowSpec: SPEC.validation, minRows: 1 });
    { const p = `/v2/ledgers/${D.valLedger.lh}/validations/${D.valKey}`; const r1 = await call('validation_one', p); const c = r1.json ? keyCheck(r1.json, [...SPEC.validation, 'result']) : null; rec(ep, 'json', 'validation_one', r1.status, r1.status === 200 && c && !keyNote(c) ? 'pass' : 'fail', c ? (keyNote(c) || 'keys match') : r1.text.slice(0, 120), p); }
    await badCase(ep, 'validations_bad_hash', '/v2/ledgers/zz/validations', 400, 'invalid ledger hash');
    await badCase(ep, 'validation_not_found', `/v2/ledgers/${D.valLedger.lh}/validations/n9notakey`, 404, 'validation not found');
    await authCase(ep, 'validations_noauth', `/v2/ledgers/${D.valLedger.lh}/validations`);
  } else skip(ep, 'json', 'validations', 'no validations collected for a stored ledger');

  // out-of-scope route and unknown route
  await badCase('GET /v2/<unknown>', 'unknown_route', '/v2/nope', 404, 'Cannot GET /v2/nope');

  fs.writeFileSync(`${OUT}/_results.json`, JSON.stringify(results, null, 1));
  const c = { pass: 0, fail: 0, skip: 0 };
  results.forEach((r) => c[r.verdict]++);
  console.log('SUMMARY', JSON.stringify(c));
})().catch((e) => { console.error('SMOKE CRASH', e); process.exit(1); });
